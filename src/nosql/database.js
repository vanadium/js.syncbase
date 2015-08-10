// Copyright 2015 The Vanadium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

module.exports = Database;

var through2 = require('through2');
var vanadium = require('vanadium');
// TODO(nlacasse): We should put unwrap and other type util methods on
// vanadium.vdl object.
var unwrap = require('vanadium/src/vdl/type-util').unwrap;

var BatchDatabase = require('./batch-database');
var nosqlVdl = require('../gen-vdl/v.io/syncbase/v23/services/syncbase/nosql');
var SyncGroup = require('./syncgroup');
var Table = require('./table');
var util = require('../util');

/**
 * Database represents a collection of Tables. Batches, queries, sync, watch,
 * etc. all operate at the Database level.
 * @constructor
 * @param {string} parentFullName Full name of App which contains this
 * Database.
 * @param {string} relativeName Relative name of this Database.  Must not
 * contain slashes.
 * @param {module:syncbase.schema.Schema} schema Schema for the database.
 * TODO(nlacasse): port definition of Schema from go to javascript
 */
function Database(parentFullName, relativeName, schema) {
  if (!(this instanceof Database)) {
    return new Database(parentFullName, relativeName);
  }

  util.addNameProperties(this, parentFullName, relativeName);

  this.schema = null;  // TODO(nlacasse): use schema from params
  this.schemaVersion = -1;  // TODO(nlacasse): derive this from schema
  /**
   * Caches the database wire object.
   * @private
   */
  Object.defineProperty(this, '_wireObj', {
    enumerable: false,
    value: null,
    writable: true
  });
}

/**
 * @private
 */
Database.prototype._wire = function(ctx) {
  if (this._wireObj) {
    return this._wireObj;
  }
  var client = vanadium.runtimeForContext(ctx).newClient();
  var signature = [nosqlVdl.Database.prototype._serviceDescription];

  this._wireObj = client.bindWithSignature(this.fullName, signature);
  return this._wireObj;
};

/**
 * Creates this Database.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {module:vanadium.security.access.Permissions} perms Permissions for
 * the new database.  If perms is null, we inherit (copy) the App perms.
 * @param {function} cb Callback.
 *
 * TODO(nlacasse): Port schema changes to javascript code. See cl:
 *    https://vanadium-review.googlesource.com/#/c/13040/ .
 */
Database.prototype.create = function(ctx, perms, cb) {
  //TODO(nlacasse): pass schema.metadata below instead of null
  this._wire(ctx).create(ctx, null, perms, cb);
};

/**
 * Deletes this Database.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {function} cb Callback.
 */
Database.prototype.delete = function(ctx, cb) {
  this._wire(ctx).delete(ctx, this.schemaVersion, cb);
};

/**
 * Returns true only if this Database exists.
 * Insufficient permissions cause exists to return false instead of an error.
 * TODO(ivanpi): exists may fail with an error if higher levels of hierarchy
 * do not exist.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {function} cb Callback.
 */
Database.prototype.exists = function(ctx, cb) {
  this._wire(ctx).exists(ctx, this.schemaVersion, cb);
};

/**
 * Executes a syncQL query.
 *
 * Returns a stream of rows.  The first row contains an array of headers (i.e.
 * column names).  Subsequent rows contain an array of values for each row that
 * matches the query.  The number of values returned in each row will match the
 * size of the headers array.
 * Concurrency semantics: It is legal to perform writes concurrently with
 * Exec. The returned stream reads from a consistent snapshot taken at the
 * time of the RPC, and will not reflect subsequent writes to keys not yet
 * reached by the stream.
 *
 * NOTE(nlacasse): The Go client library returns the headers seperately from
 * the stream.  We could potentially do something similar in JavaScript, by
 * pulling the headers off the stream and passing them to the callback.
 * However, by Vanadium JS convention the callback gets called at the *end* of
 * the RPC, so a developer would have to wait for the stream to finish before
 * seeing what the headers are, which is not ideal.  We also cannot return the
 * headers directly because reading from the stream is async.
 *
 * TODO(nlacasse): Syncbase queries don't work on values that were put without
 * type information.  When JavaScript encodes values with no type infomation,
 * it uses "vdl.Value" for the type.  Presumably, syncbase does not know how to
 * decode such objects, so queries that involve inspecting the object or its
 * type don't work.
 *
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {string} query Query string.
 * @param {function} cb Callback.
 * @returns {stream} Stream of rows.
 */
Database.prototype.exec = function(ctx, query, cb) {
  var streamUnwrapper = through2({
    objectMode: true
  }, function(res, enc, cb) {
    return cb(null, res.map(unwrap));
  });

  var stream = this._wire(ctx).exec(ctx, this.schemaVersion, query, cb).stream;

  var decodedStream = stream.pipe(streamUnwrapper);
  stream.on('error', function(err) {
    decodedStream.emit('error', err);
  });

  return decodedStream;
};

/**
 * Returns the Table with the given name.
 * @param {string} relativeName Table name.  Must not contain slashes.
 * @return {module:syncbase.table.Table} Table object.
 */
Database.prototype.table = function(relativeName) {
  return new Table(this.fullName, relativeName, this.schemaVersion);
};

/**
 * Returns a list of all Table names.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {function} cb Callback.
 */
Database.prototype.listTables = function(ctx, cb) {
  util.getChildNames(ctx, this.fullName, cb);
};

/**
 * @private
 */
Database.prototype._tableWire = function(ctx, relativeName) {
  if (relativeName.indexOf('/') >= 0) {
    throw new Error('relativeName must not contain slashes.');
  }

  var client = vanadium.runtimeForContext(ctx).newClient();
  var signature = [nosqlVdl.Table.prototype._serviceDescription];

  var fullTableName = vanadium.naming.join(this.fullName, relativeName);
  return client.bindWithSignature(fullTableName, signature);
};

// TODO(nlacasse): It's strange that we create a Database with:
//   var db = new Database();
//   db.create();
// But we create a Table with:
//   db.createTable();
// The .delete method is similarly confusing.  db.delete deletes a database,
// but table.delete deletes a row (or row range).
// Consider puting all 'create' and 'delete' methods on the parent class for
// consistency.
// TODO(aghassemi): If we keep this, it should return "table" in the CB instead
// of being void.
/**
 * Creates the specified Table.
 * If perms is nil, we inherit (copy) the Database perms.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {string} relativeName Table name.  Must not contain slashes.
 * @param {module:vanadium.security.access.Permissions} perms Permissions for
 * the new database.  If perms is null, we inherit (copy) the Database perms.
 * @param {function} cb Callback.
 */
Database.prototype.createTable = function(ctx, relativeName, perms, cb) {
  this._tableWire(ctx, relativeName).create(ctx, this.schemaVersion, perms, cb);
};

/**
 * Deletes the specified Table.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {string} relativeName Relative name of Table to delete.  Must not
 * contain slashes.
 * @param {function} cb Callback.
 */
Database.prototype.deleteTable = function(ctx, relativeName, cb) {
  this._tableWire(ctx, relativeName).delete(ctx, this.schemaVersion, cb);
};

/**
 * Replaces the current Permissions for the Database.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {module:vanadium.security.access.Permissions} perms Permissions for
 * the database.
 * @param {string} version Version of the current Permissions object which will
 * be overwritten. If empty, SetPermissions will perform an unconditional
 * update.
 * @param {function} cb Callback.
 */
Database.prototype.setPermissions = function(ctx, perms, version, cb) {
  this._wire(ctx).setPermissions(ctx, perms, version, cb);
};

/**
 * Returns the current Permissions for the Database.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {function} cb Callback.
 */
Database.prototype.getPermissions = function(ctx, cb) {
  this._wire(ctx).getPermissions(ctx, cb);
};

/**
 * Creates a new batch. Instead of calling this function directly, clients are
 * encouraged to use the RunInBatch() helper function, which detects "concurrent
 * batch" errors and handles retries internally.
 *
 * Default concurrency semantics:
 * - Reads (e.g. gets, scans) inside a batch operate over a consistent snapshot
 *   taken during beginBatch(), and will see the effects of prior writes
 *   performed inside the batch.
 * - commit() may fail with errConcurrentBatch, indicating that after
 *   beginBatch() but before commit(), some concurrent routine wrote to a key
 *   that matches a key or row-range read inside this batch.
 * - Other methods will never fail with error errConcurrentBatch, even if it is
 *   known that commit() will fail with this error.
 *
 * Once a batch has been committed or aborted, subsequent method calls will
 * fail with no effect.
 *
 * Concurrency semantics can be configured using BatchOptions.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {module:vanadium.syncbase.nosql.BatchOptions} opts BatchOptions.
 * @param {function} cb Callback.
 */
Database.prototype.beginBatch = function(ctx, opts, cb) {
  var self = this;
  this._wire(ctx).beginBatch(ctx, this.schemaVersion, opts,
    function(err, relativeName) {
      if (err) {
        return cb(err);
      }

      // The relativeName returned from the beginBatch() call above is different
      // than the relativeName of the current database. We must create a new
      // Database with this new relativeName, and then create a BatchDatabase
      // from that new Database.
      var db = new Database(self._parentFullName, relativeName);
      return cb(null, new BatchDatabase(db));
    });
};

/**
 * Gets a handle to the SyncGroup with the given name.
 *
 * @param {string} name SyncGroup name.
 */
Database.prototype.syncGroup = function(name) {
  return new SyncGroup(this, name);
};

/**
 * Gets the global names of all SyncGroups attached to this database.
 * @param {module:vanadium.context.Context} ctx Vanadium context.
 * @param {function} cb Callback.
 */
Database.prototype.getSyncGroupNames = function(ctx, cb) {
  this._wire(ctx).getSyncGroupNames(ctx, cb);
};
