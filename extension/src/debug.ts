
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
	ContinuedEvent,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';

import * as unreal from './unreal-debugclient';

//import { ASDebugRuntime, ASBreakpoint } from './debugRuntime';
const { Subject } = require('await-notify');


interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	stopOnEntry?: boolean;
	trace?: boolean;
}

interface ASBreakpoint
{
	id : number;
	line : number;
}

let GLOBID = 0;

export class ASDebugSession extends LoggingDebugSession
{
	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private breakpoints = new Map<string, ASBreakpoint[]>();
	private nextBreakpointId = 1;

	private _variableHandles = new Handles<string>();

	private _configurationDone = new Subject();
	private instId = 0;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
		public constructor()
		{
		super("angelscript-debug");

		this.instId = GLOBID++;

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		unreal.events.removeAllListeners();
		unreal.events.on("CallStack", (msg : unreal.Message) => {
			this.receiveCallStack(msg);
		});

		unreal.events.on("Stopped", (msg : unreal.Message) => {
			this.receiveStopped(msg);
		});

		unreal.events.on("Continued", (msg : unreal.Message) => {
			this.receiveContinued();
		});

		unreal.events.on("Variables", (msg : unreal.Message) => {
			this.receiveVariables(msg);
		});

		unreal.events.on("Evaluate", (msg : unreal.Message) => {
			this.receiveEvaluate(msg);
		});

		unreal.events.on("BreakFilters", (msg : unreal.Message) => {
			this.receiveBreakFilters(msg);
		});

		unreal.events.on("Closed", () => {
			this.receiveClosed();
		});

		/*this._runtime = new ASDebugRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', ASDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', ASDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', ASDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', ASDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: ASBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: true, id: 0 }));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});*/
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */

	waitingInitializeResponse : DebugProtocol.InitializeResponse;
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) : void
	{
		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsExceptionInfoRequest = true;

		unreal.connect();
		unreal.sendRequestBreakFilters();

		this.waitingInitializeResponse = response;
	}

	receiveBreakFilters(msg : unreal.Message) : void
	{
		this.waitingInitializeResponse.body.exceptionBreakpointFilters = [];
		let count = msg.readInt();
		for (let i = 0; i < count; ++i)
		{
			let filter = msg.readString();
			let filterTitle = msg.readString();

			this.waitingInitializeResponse.body.exceptionBreakpointFilters.push(
				<DebugProtocol.ExceptionBreakpointsFilter> {
					filter: filter,
					label: filterTitle,
					default: true,
				}, 
			);
		}

		unreal.disconnect();

		this.sendResponse(this.waitingInitializeResponse);

		// since this debug adapter can accept configuration requests like 'setASBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) : void
	{
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments)
	{
		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		unreal.connect();
		unreal.sendStartDebugging();

		for (let clientPath of this.breakpoints.keys())
		{
			let breakpointList = this.getBreakpointList(clientPath);
			if (breakpointList.length != 0)
			{
				const debugPath = this.convertClientPathToDebugger(clientPath);
				unreal.clearBreakpoints(debugPath);

				for(let breakpoint of breakpointList)
				{
					unreal.setBreakpoint(debugPath, breakpoint.line);
				}
			}
		}

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

		// start the program in the runtime
		//this._runtime.start(args.program, !!args.stopOnEntry);

		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void
	{
		unreal.sendStopDebugging();
		unreal.disconnect();

		this.sendResponse(response);
	}

	protected getBreakpointList(path : string) : Array<ASBreakpoint>
	{
		let breakpointList = this.breakpoints.get(path);
		if(!breakpointList)
		{
			breakpointList = new Array<ASBreakpoint>();
			this.breakpoints.set(path, breakpointList);
		}
		return breakpointList;
	}

		protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) : void
		{
		const clientLines = args.lines || [];
		const clientPath = <string>args.source.path;
		const debugPath = this.convertClientPathToDebugger(clientPath);

		let clientBreakpoints = new Array<DebugProtocol.Breakpoint>();
		let breakpointList = this.getBreakpointList(clientPath);

		if(unreal.connected)
			unreal.clearBreakpoints(debugPath);

		for (let line of clientLines)
		{
			let clientBreak = <DebugProtocol.Breakpoint> new Breakpoint(true, line);
			clientBreakpoints.push(clientBreak);

			let breakpoint = <ASBreakpoint> { id: this.nextBreakpointId++, line: line };
			breakpointList.push(breakpoint);

			if(unreal.connected)
				unreal.setBreakpoint(debugPath, line);
		}

		this.breakpoints.set(clientPath, breakpointList);

		response.body = {
			breakpoints: clientBreakpoints
		};
		this.sendResponse(response);
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments)
	{
		unreal.sendBreakOptions(args.filters);
		this.sendResponse(response);
	}

		protected threadsRequest(response: DebugProtocol.ThreadsResponse): void
		{
		// runtime supports now threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(ASDebugSession.THREAD_ID, "Unreal Editor")
			]
		};
		this.sendResponse(response);
	}


	waitingTraces : Array<DebugProtocol.StackTraceResponse>;

		protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) : void
		{
		unreal.sendRequestCallStack();

		if(!this.waitingTraces)
			this.waitingTraces = new Array<DebugProtocol.StackTraceResponse>();

		this.waitingTraces.push(response);
	}

	protected receiveCallStack(msg : unreal.Message)
	{
		let stack = new Array<StackFrame>();

		let count = msg.readInt();
		for(let i = 0; i < count; ++i)
		{
			let name = msg.readString().replace(/_Implementation$/, "");
			let source = this.createSource(msg.readString());
			let line = msg.readInt();

			let frame = new StackFrame(i, name, source, line, 1);
			stack.push(frame);
		}

		if(stack.length == 0)
		{
			stack.push(new StackFrame(0, "No CallStack", this.createSource(""), 1));
		}

		if (this.waitingTraces && this.waitingTraces.length > 0)
		{
			let response = this.waitingTraces[0];
			this.waitingTraces.splice(0, 1);

			response.body = {
				stackFrames: stack,
				totalFrames: stack.length,
			};

			this.sendResponse(response);
		}
	}

		protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) : void
		{

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Variables", this._variableHandles.create(frameReference+":%local%"), false));
		scopes.push(new Scope("this", this._variableHandles.create(frameReference+":%this%"), false));
		scopes.push(new Scope("Globals", this._variableHandles.create(frameReference+":%module%"), false));

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
	}

	waitingVariableRequests : Array<any>;

		protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) : void
		{

		const id = this._variableHandles.get(args.variablesReference);
		unreal.sendRequestVariables(id);

		if(!this.waitingVariableRequests)
			this.waitingVariableRequests = new Array<any>();

		this.waitingVariableRequests.push({
			response: response,
			id: id,
		});
	}

	combineExpression(expr : string, variable : string) : string
	{
		if(variable.startsWith("[") && variable.endsWith("]"))
			return expr + variable;

		return expr + "." + variable;
	}

	protected receiveVariables(msg : unreal.Message)
	{
		let id = "";
		if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0)
		{
			id = this.waitingVariableRequests[0].id;
		}

		let variables = new Array<DebugProtocol.Variable>();

		let count = msg.readInt();
		for(let i = 0; i < count; ++i)
		{
			let name = msg.readString();
			let value = msg.readString();
			let type = msg.readString();
			let bHasMembers = msg.readBool();

			let evalName = this.combineExpression(id, name);

			let varRef = 0;
			if (bHasMembers)
				varRef = this._variableHandles.create(evalName);

			let variable = {
				name: name,
				type: type,
				value: value,
				variablesReference: varRef,
				evaluateName: evalName.replace(/^[0-9]+:%.*%./g, ""),
			};

			variables.push(variable);
		}

		if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0)
		{
			let response = this.waitingVariableRequests[0].response;
			this.waitingVariableRequests.splice(0, 1);

			response.body = {
				variables: variables,
			};

			this.sendResponse(response);
		}
	}

		protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) : void
		{
		unreal.sendContinue();
		this.sendResponse(response);
	}

	protected receiveContinued()
	{
		this.sendEvent(new ContinuedEvent(ASDebugSession.THREAD_ID));
	}

	protected receiveClosed()
	{
		this.sendEvent(new TerminatedEvent());
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void
	{
		unreal.sendPause();
		this.sendResponse(response);
	}

	previousException : string;
	protected receiveStopped(msg : unreal.Message)
	{
		let Reason = msg.readString();
		let Description = msg.readString();
		let Text = msg.readString();

		if(Text.length != 0 && Reason == 'exception')
		{
			this.previousException = Text;
			this.sendEvent(new StoppedEvent(Reason, ASDebugSession.THREAD_ID, Text));
		}
		else
		{
			this.previousException = null;
			this.sendEvent(new StoppedEvent(Reason, ASDebugSession.THREAD_ID));
		}
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments): void
	{
		if(!this.previousException)
		{
			this.sendResponse(response);
			return;
		}

		response.body = {
			exceptionId: "",
			breakMode: "unhandled",
			description: this.previousException,
		};
		this.sendResponse(response);
	}

		protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) : void
		{
		unreal.sendStepOver();
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void
	{
		unreal.sendStepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void
	{
		unreal.sendStepOut();
		this.sendResponse(response);
	}

	protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void
	{
		//unreal.sendEngineBreak();
		this.sendResponse(response);
	}

	waitingEvaluateRequests : Array<any>;
		protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) : void
		{
		unreal.sendRequestEvaluate(args.expression, args.frameId);

		if(!this.waitingEvaluateRequests)
			this.waitingEvaluateRequests = new Array<any>();

		this.waitingEvaluateRequests.push({
			expression: args.expression,
			frameId: args.frameId,
			response: response,
		});
	}

	protected receiveEvaluate(msg : unreal.Message)
	{
		let id = "";
		if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0)
		{
			id = this.waitingEvaluateRequests[0].expression;
			if(!/^[0-9]+:/.test(id))
			{
				id = this.waitingEvaluateRequests[0].frameId + ":" + id;
			}
		}

		let name = msg.readString();
		let value = msg.readString();
		let type = msg.readString();
		let bHasMembers = msg.readBool();

		if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0)
		{
			let response = this.waitingEvaluateRequests[0].response;
			this.waitingEvaluateRequests.splice(0, 1);

			if(value.length == 0)
			{

			}
			else
			{
				response.body = {
					result: value,
					variablesReference: bHasMembers ? this._variableHandles.create(id) : 0,
				};
			}
			this.sendResponse(response);
		}
	}

	//---- helpers
		private createSource(filePath: string): Source
		{
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'as-adapter-data');
	}
}
