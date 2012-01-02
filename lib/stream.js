// Changes stream
//
// Copyright 2011 Iris Couch
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//
//        http://www.apache.org/licenses/LICENSE-2.0
//
//    Unless required by applicable law or agreed to in writing, software
//    distributed under the License is distributed on an "AS IS" BASIS,
//    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//    See the License for the specific language governing permissions and
//    limitations under the License.

var lib = require('../lib')
  , util = require('util')
  , stream = require('stream')
  , request = require('request')

// Use the library timeout functions, primarily so the test suite can catch errors.
var setTimeout = lib.setTimeout
  , clearTimeout = lib.clearTimeout


var DEFS =
  { 'longpoll_header': '{"results":['
  }

module.exports = { 'Changes': Changes
                 }


util.inherits(Changes, stream)
function Changes (opts) {
  var self = this
  stream.call(self)

  self.readable = true
  self.writable = true

  opts = opts || {}
  self.feed = opts.feed || null // "continuous" or "longpoll"

  self.is_sending = true
  self.is_ending = false
  self.request = null
  self.expect = null
  self.buf = null
  self.changes = []
}


Changes.prototype.assert_request = function() {
  var self = this
  if(!self.request)
    throw new Error('No incoming request yet')
}


Changes.prototype.setEncoding = function(encoding) {
  var self = this
  self.assert_request()
  return self.request.setEncoding(encoding)
}


Changes.prototype.pause = function() {
  var self = this
  self.is_sending = false
  if(self.request)
    self.request.pause()
}


Changes.prototype.resume = function() {
  var self = this
  self.is_sending = true
  if(self.request)
    self.request.resume()
  self.emit_changes()
}

//
// Writable stream API
//

Changes.prototype.write = function(data, encoding) {
  var self = this

  data = self.normalize_data(data)
  if(typeof data != 'string')
    return // Looks like normalize_data emitted an error.

  if(self.feed === 'longpoll')
    return self.write_longpoll(data)
  else if(self.feed === 'continuous')
    return self.write_continuous(data)
}


Changes.prototype.write_longpoll = function(data) {
  var self = this

  if(self.buf === null)
    self.buf = []

  self.buf.push(data)
  return true
}


Changes.prototype.write_continuous = function(data) {
  var self = this

  var offset, json, change
    , buf = (self.buf || "") + data

  console.error('buf: ' + util.inspect(buf))

  // Buf could have 0, 1, or many JSON objects in it.
  while((offset = buf.indexOf("\n")) >= 0) {
    json = buf.substr(0, offset);
    buf = buf.substr(offset + 1);
    console.error('JSON: ' + util.inspect(json))

    // Heartbeats (empty strings) are fine, but otherwise confirm valid JSON.
    if(json === "")
      ;

    else if(json[0] !== '{')
      return self.error(new Error('Non-object JSON data: ' + json))

    else {
      try { change = JSON.parse(json) }
      catch (er) { return self.error(er) }

      console.error('Object: ' + util.inspect(change))
      json = JSON.stringify(change)
    }

    // Change (or heartbeat) looks good.
    self.changes.push(json)
  }

  // Remember the unused data and send all known good changes (or heartbeats).
  self.buf = buf
  self.emit_changes()

  return self.is_sending
}


Changes.prototype.end = function(data, encoding) {
  var self = this

  // Set .is_ending before the .write() so it can fire the "end" event as well.
  self.is_ending = true

  if(data)
    self.write(data, encoding)

  self.writable = false

  if(self.feed === 'longpoll') {
    var changes = [ DEFS.longpoll_header ].concat(self.buf).join('')
    try { changes = JSON.parse(changes) || {} }
    catch (er) { return self.error(er) }

    if(!Array.isArray(changes.results))
      return self.error(new Error('No "results" field in feed'))
    if(self.changes.length !== 0)
      return self.error(new Error('Changes are already queued: ' + JSON.stringify(self.changes)))

    self.changes = changes.results.map(function(change) { return JSON.stringify(change) })
    return self.emit_changes()
  }

  else if(self.feed === 'continuous') {
    if(self.buf !== "")
      self.error(new Error('Unprocessed data after end received: ' + self.buf))
  }
}


Changes.prototype.emit_changes = function() {
  var self = this

  while(self.is_sending && self.changes.length > 0) {
    var change = self.changes.shift()
    self.emit('data', change)
  }

  if(self.is_sending && self.is_ending && self.changes.length === 0) {
    self.is_ending = false
    self.readable = false
    self.emit('end')
  }
}

//
// Readable/writable stream API
//

Changes.prototype.destroy = function() {
  var self = this
  self.assert_request()
  return self.request.destroy()
}


Changes.prototype.destroySoon = function() {
  var self = this
  self.assert_request()
  return self.request.destroySoon()
}

//
// Internal implementation
//

Changes.prototype.normalize_data = function(data) {
  var self = this

  if(self.feed !== 'continuous' && self.feed !== 'longpoll')
    return self.error(new Error('Must set .feed to "continuous" or "longpoll" before writing data'))

  if(self.expect === null)
    self.expect = (self.feed == 'longpoll')
                    ? DEFS.longpoll_header
                    : ""

  var prefix = data.substr(0, self.expect.length)
  data = data.substr(prefix.length)

  var expected_part = self.expect.substr(0, prefix.length)
    , expected_remainder = self.expect.substr(expected_part.length)

  if(prefix !== expected_part)
    return self.error(new Error('Prefix not expected '+util.inspect(expected_part)+': ' + util.inspect(prefix)))

  self.expect = expected_remainder
  return data
}


Changes.prototype.error = function(er) {
  var self = this

  self.readable = false
  self.writable = false
  self.emit('error', er)
}