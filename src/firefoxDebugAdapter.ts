import { DebugProtocol } from 'vscode-debugprotocol';
import { DebugSession, StoppedEvent, OutputEvent, Thread, Variable, Breakpoint } from 'vscode-debugadapter';
import { Log } from './util/log';
import { accessorExpression } from './util/misc';
import { DebugAdapterBase } from './debugAdapterBase';
import { ExceptionBreakpoints } from './firefox/index';
import { ThreadAdapter, SourceAdapter } from './adapter/index';
import { LaunchConfiguration, AttachConfiguration, parseConfiguration } from "./configuration";
import { FirefoxDebugSession } from './firefoxDebugSession';
import { popupAutohidePreferenceKey } from './adapter/addonManager';

let log = Log.create('FirefoxDebugAdapter');

export class FirefoxDebugAdapter extends DebugAdapterBase {

	private session!: FirefoxDebugSession;

	public constructor(debuggerLinesStartAt1: boolean, isServer: boolean = false) {
		super(debuggerLinesStartAt1, isServer);

		if (!isServer) {
			Log.consoleLog = (msg: string) => {
				this.sendEvent(new OutputEvent(msg + '\n'));
			}
		}
	}

	protected initialize(args: DebugProtocol.InitializeRequestArguments): DebugProtocol.Capabilities {
		return {
			supportsConfigurationDoneRequest: false,
			supportsEvaluateForHovers: false,
			supportsFunctionBreakpoints: false,
			supportsConditionalBreakpoints: true,
			supportsSetVariable: true,
			supportsCompletionsRequest: true,
			supportsDelayedStackTraceLoading: true,
			supportsHitConditionalBreakpoints: true,
			supportsLogPoints: true,
			exceptionBreakpointFilters: [
				{
					filter: 'all',
					label: 'All Exceptions',
					default: false
				},
				{
					filter: 'uncaught',
					label: 'Uncaught Exceptions',
					default: true
				}
			]
		};
	}

	protected async launch(args: LaunchConfiguration): Promise<void> {
		await this.startSession(args);
	}

	protected async attach(args: AttachConfiguration): Promise<void> {
		await this.startSession(args);
	}

	private async startSession(config: LaunchConfiguration | AttachConfiguration): Promise<void> {
		if (config.log) {
			Log.setConfig(config.log);
		}
		let parsedConfig = await parseConfiguration(config);
		this.session = new FirefoxDebugSession(parsedConfig, (ev) => this.sendEvent(ev));
		await this.session.start();
	}

	protected setBreakpoints(args: DebugProtocol.SetBreakpointsArguments): { breakpoints: DebugProtocol.Breakpoint[] } {
		
		const requestedBreakpoints = args.breakpoints;
		if (requestedBreakpoints === undefined) {
			log.error('setBreakpoints request without any breakpoints');
			return { breakpoints: [] };
		}

		// a path for local sources and a url (as seen by Firefox) for remote sources
		const sourcePathOrUrl = args.source.path;
		if (sourcePathOrUrl === undefined) {
			throw 'Couldn\'t set breakpoint: unknown source path';
		}

		const breakpointInfos = this.session.breakpointsManager.setBreakpoints(requestedBreakpoints, sourcePathOrUrl);

		const breakpoints = breakpointInfos.map(breakpointInfo => {
			const breakpoint: DebugProtocol.Breakpoint = new Breakpoint(
				breakpointInfo.verified,
				breakpointInfo.requestedBreakpoint.line,
				breakpointInfo.requestedBreakpoint.column
			);
			breakpoint.id = breakpointInfo.id;
			return breakpoint;
		});

		return { breakpoints };
	}

	protected setExceptionBreakpoints(args: DebugProtocol.SetExceptionBreakpointsArguments): void {
		log.debug(`Setting exception filters: ${JSON.stringify(args.filters)}`);

		let exceptionBreakpoints = ExceptionBreakpoints.None;

		if (args.filters.indexOf('all') >= 0) {
			exceptionBreakpoints = ExceptionBreakpoints.All;
		} else if (args.filters.indexOf('uncaught') >= 0) {
			exceptionBreakpoints = ExceptionBreakpoints.Uncaught;
		}

		this.session.setExceptionBreakpoints(exceptionBreakpoints);
	}

	protected async pause(args: DebugProtocol.PauseArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.session.setActiveThread(threadAdapter);

		await threadAdapter.interrupt();

		let stoppedEvent = new StoppedEvent('interrupt', threadAdapter.id);
		(<DebugProtocol.StoppedEvent>stoppedEvent).body.allThreadsStopped = false;
		this.sendEvent(stoppedEvent);
	}

	protected async next(args: DebugProtocol.NextArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.session.setActiveThread(threadAdapter);

		await threadAdapter.stepOver();
	}

	protected async stepIn(args: DebugProtocol.StepInArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.session.setActiveThread(threadAdapter);

		await threadAdapter.stepIn();
	}

	protected async stepOut(args: DebugProtocol.StepOutArguments): Promise<void> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.session.setActiveThread(threadAdapter);

		await threadAdapter.stepOut();
	}

	protected async continue(args: DebugProtocol.ContinueArguments): Promise<{ allThreadsContinued?: boolean }> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.session.setActiveThread(threadAdapter);

		await threadAdapter.resume();
		return { allThreadsContinued: false };
	}

	protected async getSource(args: DebugProtocol.SourceArguments): Promise<{ content: string, mimeType?: string }> {

		let sourceAdapter: SourceAdapter | undefined;
		if (args.sourceReference !== undefined) {

			let sourceReference = args.sourceReference;
			sourceAdapter = this.session.sources.find(sourceReference);

		} else if (args.source && args.source.path) {

			sourceAdapter = this.session.findSourceAdapter(args.source.path, true);

		}

		if (!sourceAdapter) {
			throw new Error('Failed sourceRequest: the requested source can\'t be found');
		}

		let sourceGrip = await sourceAdapter.actor.fetchSource();

		if (typeof sourceGrip === 'string') {

			return { content: sourceGrip, mimeType: 'text/javascript' };

		} else {

			let longStringGrip = <FirefoxDebugProtocol.LongStringGrip>sourceGrip;
			let longStringActor = this.session.getOrCreateLongStringGripActorProxy(longStringGrip);
			let content = await longStringActor.fetchContent();
			return { content, mimeType: 'text/javascript' };

		}
	}

	protected getThreads(): { threads: DebugProtocol.Thread[] } {
		
		log.debug(`${this.session.threads.count} threads`);

		let threads = this.session.threads.map(
			(threadAdapter) => new Thread(threadAdapter.id, threadAdapter.name));

		return { threads };
	}

	protected async getStackTrace(args: DebugProtocol.StackTraceArguments): Promise<{ stackFrames: DebugProtocol.StackFrame[], totalFrames?: number }> {

		let threadAdapter = this.getThreadAdapter(args.threadId);
		this.session.setActiveThread(threadAdapter);

		let [frameAdapters, totalFrames] = 
			await threadAdapter.fetchStackFrames(args.startFrame || 0, args.levels || 0);

		let stackFrames = frameAdapters.map((frameAdapter) => frameAdapter.getStackframe());

		return { stackFrames, totalFrames };
	}

	protected getScopes(args: DebugProtocol.ScopesArguments): { scopes: DebugProtocol.Scope[] } {

		let frameAdapter = this.session.frames.find(args.frameId);
		if (!frameAdapter) {
			throw new Error('Failed scopesRequest: the requested frame can\'t be found');
		}

		this.session.setActiveThread(frameAdapter.threadAdapter);

		let scopes = frameAdapter.scopeAdapters.map((scopeAdapter) => scopeAdapter.getScope());

		return { scopes };
	}

	protected async getVariables(args: DebugProtocol.VariablesArguments): Promise<{ variables: DebugProtocol.Variable[] }> {

		let variablesProvider = this.session.variablesProviders.find(args.variablesReference);
		if (!variablesProvider) {
			throw new Error('Failed variablesRequest: the requested object reference can\'t be found');
		}

		this.session.setActiveThread(variablesProvider.threadAdapter);

		try {

			let variables = await variablesProvider.threadAdapter.fetchVariables(variablesProvider);

			return { variables };

		} catch(err) {

			let msg: string;
			if (err === 'No such actor') {
				msg = 'Value can\'t be inspected - this is probably due to Firefox bug #1249962';
			} else {
				msg = String(err);
			}

			return { variables: [ new Variable('Error from debugger', msg) ]};
		}
	}

	protected async setVariable(args: DebugProtocol.SetVariableArguments): Promise<{ value: string, variablesReference?: number }> {

		let variablesProvider = this.session.variablesProviders.find(args.variablesReference);
		if (variablesProvider === undefined) {
			throw new Error('Failed setVariableRequest: the requested context can\'t be found')
		}
		if (variablesProvider.referenceFrame === undefined) {
			throw new Error('Failed setVariableRequest: the requested context has no associated stack frame');
		}

		let referenceExpression = accessorExpression(variablesProvider.referenceExpression, args.name);
		let setterExpression = `${referenceExpression} = ${args.value}`;
		let frameActorName = variablesProvider.referenceFrame.frame.actor;
		let result = await variablesProvider.threadAdapter.evaluate(setterExpression, false, frameActorName);

		return { value: result.value, variablesReference: result.variablesReference };
	}

	protected async evaluate(args: DebugProtocol.EvaluateArguments): Promise<{ result: string, type?: string, variablesReference: number, namedVariables?: number, indexedVariables?: number }> {

		let variable: Variable | undefined = undefined;

		if (args.context === 'watch') {

			if (args.frameId !== undefined) {

				let frameAdapter = this.session.frames.find(args.frameId);
				if (frameAdapter !== undefined) {

					this.session.setActiveThread(frameAdapter.threadAdapter);

					let threadAdapter = frameAdapter.threadAdapter;
					let frameActorName = frameAdapter.frame.actor;

					variable = await threadAdapter.evaluate(args.expression, true, frameActorName);

				} else {
					log.warn(`Couldn\'t find specified frame for evaluating ${args.expression}`);
					throw 'not available';
				}

			} else {

				let threadAdapter = this.session.getActiveThread();
				if (threadAdapter !== undefined) {

					variable = await threadAdapter.evaluate(args.expression, true);

				} else {
					log.info(`Couldn't find a thread for evaluating watch ${args.expression}`);
					throw 'not available';
				}
			}

		} else {

			let threadAdapter = this.session.getActiveThread();
			if (threadAdapter !== undefined) {

				let frameActorName: string | undefined = undefined;
				if (args.frameId !== undefined) {
					let frameAdapter = this.session.frames.find(args.frameId);
					if (frameAdapter !== undefined) {
						frameActorName = frameAdapter.frame.actor;
					}
				}

				variable = await threadAdapter.evaluate(args.expression, false, frameActorName);

			} else {
				log.info(`Couldn't find a thread for evaluating ${args.expression}`);
				throw 'not available';
			}
		}

		return {
			result: variable.value,
			variablesReference: variable.variablesReference
		};
	}

	protected async getCompletions(args: DebugProtocol.CompletionsArguments): Promise<{ targets: DebugProtocol.CompletionItem[] }> {

		let matches: string[];

		if (args.frameId !== undefined) {

			let frameAdapter = this.session.frames.find(args.frameId);

			if (frameAdapter === undefined) {
				log.warn(`Couldn\'t find specified frame for auto-completing ${args.text}`);
				throw 'not available';
			}

			this.session.setActiveThread(frameAdapter.threadAdapter);

			let threadAdapter = frameAdapter.threadAdapter;
			let frameActorName = frameAdapter.frame.actor;

			matches = await threadAdapter.autoComplete(args.text, args.column - 1, frameActorName);

		} else {

			let threadAdapter = this.session.getActiveThread();

			if (threadAdapter === undefined) {
				log.warn(`Couldn't find a thread for auto-completing ${args.text}`);
				throw 'not available';
			}

			matches = await threadAdapter.autoComplete(args.text, args.column - 1);
		}

		return { 
			targets: matches.map((match) => <DebugProtocol.CompletionItem>{ label: match })
		 };
	}

	protected async reloadAddon(): Promise<void> {
		if (!this.session.addonManager) {
			throw 'This command is only available when debugging an addon'
		}

		await this.session.addonManager.reloadAddon();
	}

	// url is a file:// url for local sources and the original url (as seen by Firefox) for remote sources
	protected async toggleSkippingFile(url: string): Promise<void> {

		if (url.startsWith('file://')) {

			let path: string;
			if (this.session.isWindowsPlatform) {
				path = url.substr(8).replace(/\//g, '\\').replace('%3A', ':');
			} else {
				path = url.substr(7);
			}

			await this.session.skipFilesManager.toggleSkippingPath(path);

		} else {

			await this.session.skipFilesManager.toggleSkippingUrl(url);

		}
	}

	protected async setPopupAutohide(enabled: boolean): Promise<void> {
		await this.session.preferenceActor.setBoolPref(popupAutohidePreferenceKey, !enabled);
	}

	protected async togglePopupAutohide(): Promise<boolean> {
		const currentValue = await this.session.preferenceActor.getBoolPref(popupAutohidePreferenceKey);
		const newValue = !currentValue;
		await this.session.preferenceActor.setBoolPref(popupAutohidePreferenceKey, newValue);
		return !newValue;
	}

	protected async disconnect(args: DebugProtocol.DisconnectArguments): Promise<void> {
		await this.session.stop();
	}

	private getThreadAdapter(threadId: number): ThreadAdapter {
		let threadAdapter = this.session.threads.find(threadId);
		if (!threadAdapter) {
			throw new Error(`Unknown threadId ${threadId}`);
		}
		return threadAdapter;
	}
}

DebugSession.run(FirefoxDebugAdapter);
