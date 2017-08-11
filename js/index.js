"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = Object.setPrototypeOf ||
        ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
        function (d, b) { for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p]; };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var events = require("events");
var _ = require("lodash");
var uuid = require("uuid");
var defaultOptions = {
    TransTimeoutPollingIntervalMS: 5000,
    TransTimeoutMS: 15000
};
var Queue = (function (_super) {
    __extends(Queue, _super);
    function Queue() {
        var _this = _super.call(this) || this;
        _this._items = [];
        return _this;
    }
    Queue.itemToJSON = function (item) {
        return { Id: item.Id, EnqueueTime: item.EnqueueTime, Transaction: item.Transaction.toJSON() };
    };
    // enqueue a transaction
    Queue.prototype.enqueue = function (TransactionId, Transaction, CompletionCallback) {
        var item = { Id: TransactionId, EnqueueTime: new Date().getTime(), Transaction: Transaction, CompletionCallback: CompletionCallback };
        this._items.push(item);
        this.emit("enqueue", Queue.itemToJSON(item));
        this.emit("change");
    };
    // dequeue a transaction
    Queue.prototype.dequeue = function () {
        if (this._items.length > 0) {
            var item = this._items.shift();
            this.emit("change");
            return item;
        }
        else
            return null;
    };
    // remove all timeout transactions from the queue
    Queue.prototype.removeTimeoutTransactions = function (TransTimeoutMS) {
        if (this._items.length > 0) {
            var now = new Date().getTime();
            var indices = [];
            for (var i = this._items.length - 1; i >= 0; i--) {
                var item = this._items[i];
                if (now - item.EnqueueTime > TransTimeoutMS)
                    indices.push(i);
            }
            if (indices.length > 0) {
                var timeoutItems = [];
                for (var i in indices) {
                    var index = indices[i];
                    timeoutItems.push(this._items[index]);
                    this._items.splice(index, 1);
                }
                this.emit("transactions-timeout", timeoutItems);
                this.emit("change");
            }
        }
    };
    // flush the queue
    Queue.prototype.flush = function () {
        if (this._items.length > 0) {
            var removedItems = this._items;
            this._items = [];
            this.emit("transactions-removed", removedItems);
            this.emit("change");
        }
    };
    // remove a transaction from the queue
    Queue.prototype.remove = function (TransactionId) {
        if (this._items.length > 0) {
            for (var i in this._items) {
                var item = this._items[i];
                if (item.Id === TransactionId) {
                    this._items.splice(parseInt(i), 1);
                    this.emit("transactions-removed", [item]);
                    this.emit("change");
                    return true;
                }
            }
        }
        return false;
    };
    Object.defineProperty(Queue.prototype, "Count", {
        get: function () {
            return this._items.length;
        },
        enumerable: true,
        configurable: true
    });
    Queue.prototype.toJSON = function () {
        var ret = [];
        for (var i in this._items) {
            var item = this._items[i];
            ret.push(Queue.itemToJSON(item));
        }
        return ret;
    };
    return Queue;
}(events.EventEmitter));
;
var FIFOTransactionProcessor = (function (_super) {
    __extends(FIFOTransactionProcessor, _super);
    function FIFOTransactionProcessor(options) {
        var _this = _super.call(this) || this;
        options = options || defaultOptions;
        _this._options = _.assignIn({}, defaultOptions, options);
        _this._executingTransaction = null;
        _this._queueOpen = true;
        _this._stopped = false;
        _this._queue = new Queue();
        _this._queue.on("enqueue", function (itemJSON) {
            _this.emit("submitted", itemJSON);
            _this.executeTransactionIfNecessary();
        }).on("change", function () {
            _this.emit("change");
        }).on("transactions-timeout", function (timeoutItems) {
            var err = { error: "timeout", error_description: "transaction timeout" };
            for (var i in timeoutItems)
                _this.handleTransactionError(timeoutItems[i].Transaction, timeoutItems[i].CompletionCallback, err, timeoutItems[i].Id);
        }).on("transactions-removed", function (removedItems) {
            var err = { error: "aborted", error_description: "transaction aborted" };
            for (var i in removedItems)
                _this.handleTransactionError(removedItems[i].Transaction, removedItems[i].CompletionCallback, err, removedItems[i].Id);
        });
        _this._timer = setTimeout(_this.PollingTimeoutFunction, _this._options.TransTimeoutPollingIntervalMS);
        return _this;
    }
    Object.defineProperty(FIFOTransactionProcessor.prototype, "PollingTimeoutFunction", {
        get: function () {
            var _this = this;
            var func = function () {
                _this.emit('polling-transactions');
                _this._queue.removeTimeoutTransactions(_this._options.TransTimeoutMS);
                _this._timer = setTimeout(_this.PollingTimeoutFunction, _this._options.TransTimeoutPollingIntervalMS);
            };
            return func.bind(this);
        },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.handleTransactionError = function (Transaction, CompletionCallback, err, TransactionId) {
        this.emit("transaction-error", Transaction, err, TransactionId);
        if (typeof CompletionCallback === "function")
            CompletionCallback(err, null);
    };
    FIFOTransactionProcessor.prototype.handleTransactionSuccess = function (Transaction, CompletionCallback, result, TransactionId) {
        this.emit("transaction-success", Transaction, result, TransactionId);
        if (typeof CompletionCallback === "function")
            CompletionCallback(null, result);
    };
    // abort all transactions currently in the queue
    FIFOTransactionProcessor.prototype.abortAll = function () { this._queue.flush(); };
    // abort one transaction
    FIFOTransactionProcessor.prototype.abort = function (TransactionId) { return this._queue.remove(TransactionId); };
    // call this before removing this processor reference
    FIFOTransactionProcessor.prototype.end = function () {
        this.Open = false; // close the queue
        this.abortAll(); // abort all transactions
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    };
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Busy", {
        get: function () { return (this._executingTransaction != null); },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.setExecutingTransaction = function (value) {
        if (this._executingTransaction !== value) {
            this._executingTransaction = value;
            this.emit("change");
            if (!this.Busy)
                this.executeTransactionIfNecessary();
        }
    };
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Open", {
        get: function () { return this._queueOpen; },
        set: function (value) {
            if (this._queueOpen !== value) {
                this._queueOpen = value;
                this.emit("change");
            }
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Stopped", {
        get: function () { return this._stopped; },
        set: function (value) {
            if (this._stopped !== value) {
                this._stopped = value;
                this.emit("change");
                if (!this.Stopped)
                    this.executeTransactionIfNecessary();
            }
        },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.executeTransactionIfNecessary = function () {
        var _this = this;
        var item = null;
        if (!this.Busy && !this.Stopped && (item = this._queue.dequeue())) {
            this.setExecutingTransaction(item);
            this.emit("executing-transaction", item.Transaction, item.Id);
            item.Transaction.execute()
                .then(function (result) {
                _this.handleTransactionSuccess(item.Transaction, item.CompletionCallback, result, item.Id);
                _this.setExecutingTransaction(null);
            }).catch(function (err) {
                _this.handleTransactionError(item.Transaction, item.CompletionCallback, err, item.Id);
                _this.setExecutingTransaction(null);
            });
        }
    };
    FIFOTransactionProcessor.prototype.generateTransactionId = function () { return uuid.v4().replace(/-/gi, ""); };
    Object.defineProperty(FIFOTransactionProcessor.prototype, "QueueClosedError", {
        get: function () { return { error: "forbidden", error_description: "submitting transaction is not allowed at this time" }; },
        enumerable: true,
        configurable: true
    });
    // submit a transaction to be executed
    FIFOTransactionProcessor.prototype.submit = function (Transaction) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            if (_this.Open) {
                var TransactionId = _this.generateTransactionId();
                _this._queue.enqueue(TransactionId, Transaction, null);
                resolve(TransactionId);
            }
            else {
                _this.handleTransactionError(Transaction, null, _this.QueueClosedError, null);
                reject(_this.QueueClosedError);
            }
        });
    };
    // commit a transaction
    FIFOTransactionProcessor.prototype.transact = function (Transaction) {
        var _this = this;
        return new Promise(function (resolve, reject) {
            if (_this.Open) {
                _this._queue.enqueue(_this.generateTransactionId(), Transaction, function (err, result) {
                    if (err)
                        reject(err);
                    else
                        resolve(result);
                });
            }
            else {
                _this.handleTransactionError(Transaction, null, _this.QueueClosedError, null);
                reject(_this.QueueClosedError);
            }
        });
    };
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Queue", {
        get: function () { return this._queue.toJSON(); },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(FIFOTransactionProcessor.prototype, "Options", {
        get: function () { return _.assignIn({}, this._options); },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(FIFOTransactionProcessor.prototype, "ExecutingTransaction", {
        get: function () { return (this._executingTransaction ? Queue.itemToJSON(this._executingTransaction) : null); },
        enumerable: true,
        configurable: true
    });
    FIFOTransactionProcessor.prototype.toJSON = function () {
        return {
            Options: this.Options,
            Busy: this.Busy,
            Open: this.Open,
            Stopped: this.Stopped,
            QueueCount: this._queue.Count,
            ExecutingTransaction: this.ExecutingTransaction
        };
    };
    return FIFOTransactionProcessor;
}(events.EventEmitter));
function get(options) { return new FIFOTransactionProcessor(options); }
exports.get = get;
