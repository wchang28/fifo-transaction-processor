/// <reference types="node" />
import * as events from "events";
export declare type TransactionCompletionCallback = (err: any, result: any) => void;
export interface ITransaction {
    execute: () => Promise<any>;
    readonly CompletionCallback?: TransactionCompletionCallback;
    toJSON: () => any;
}
export interface ITransactionQueueItemJSON {
    EnqueueTime: number;
    Transaction: any;
}
export interface Options {
    TransTimeoutPollingIntervalMS?: number;
    TransTimeoutMS?: number;
}
export interface ITransactionProcessorJSON {
    Options: Options;
    Busy: boolean;
    Open: boolean;
    QueueCount: number;
}
export declare type ProcessorEvents = "submitted" | "change" | "polling-transactions" | "executing-transaction" | "transaction-success" | "transaction-error";
export interface ITransactionProcessor {
    submit: (Transaction: ITransaction) => void;
    abortAll: () => void;
    end: () => void;
    readonly Busy: boolean;
    Open: boolean;
    readonly Queue: ITransactionQueueItemJSON[];
    Options: Options;
    toJSON: () => ITransactionProcessorJSON;
    on: (event: ProcessorEvents, listener: Function) => this;
}
export declare class FIFOTransactionProcessor extends events.EventEmitter implements ITransactionProcessor {
    private _executingTransaction;
    private _queue;
    private _options;
    private _timer;
    private _queueOpen;
    private readonly PollingTimeoutFunction;
    constructor(options?: Options);
    private handleTransactionError(Transaction, err);
    private handleTransactionSuccess(Transaction, result);
    abortAll(): void;
    end(): void;
    readonly Busy: boolean;
    private setBusy(value);
    Open: boolean;
    private executeTransactionIfNecessary();
    submit(Transaction: ITransaction): void;
    readonly Queue: ITransactionQueueItemJSON[];
    readonly Options: Options;
    toJSON(): ITransactionProcessorJSON;
}
