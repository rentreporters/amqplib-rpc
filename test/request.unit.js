var EventEmitter = require('events').EventEmitter

var Channel = require('amqplib/lib/channel_model').Channel
var Code = require('code')
var Connection = require('amqplib/lib/channel_model').ChannelModel
var Lab = require('lab')
var proxyquire = require('proxyquire')
var put = require('101/put')
var shimmer = require('shimmer')
var sinon = require('sinon')
require('sinon-as-promised')

global.Promise = global.Promise || require('promise-polyfill')

var ChannelCloseError = require('../lib/errors/channel-close-error.js')
var TimeoutError = require('../lib/errors/timeout-error.js')

var bufferMatch = function (a) {
  return sinon.match(function (b) {
    return a.toString() === b.toString()
  })
}

var lab = exports.lab = Lab.script()
var describe = lab.describe
var it = lab.it
var beforeEach = lab.beforeEach
var expect = Code.expect

describe('request', function () {
  var ctx

  beforeEach(function (done) {
    ctx = {}
    ctx.corrId = 1
    ctx.uuid = sinon.stub().returns(ctx.corrId)
    ctx.request = proxyquire('../lib/request.js', {
      'uuid': ctx.uuid
    })
    // stubbed connection
    ctx.connection = new Connection(new EventEmitter())
    sinon.stub(ctx.connection, 'createChannel')
    // stubbed channel
    ctx.channel = new Channel()
    sinon.stub(ctx.channel, 'assertQueue')
    sinon.stub(ctx.channel, 'consume')
    sinon.stub(ctx.channel, 'sendToQueue')
    sinon.stub(ctx.channel, 'close')
    // queue args
    ctx.rpcQueueName = 'rpc-queue'
    ctx.opts = {
      sendOpts: { foo: 1 },
      queueOpts: { bar: 1 },
      consumeOpts: { qux: 1 }
    }
    ctx.replyQueue = { queue: 'replyQueueName' }
    done()
  })

  describe('success', function () {
    describe('callback api', function () {
      beforeEach(function (done) {
        ctx.connection.createChannel.resolves(ctx.channel)
        ctx.channel.assertQueue.resolves(ctx.replyQueue)
        ctx.resMessage = {
          properties: {
            correlationId: ctx.corrId
          },
          content: new Buffer('response')
        }
        ctx.channel.consume
          .resolves()
          .callsArgWithAsync(1, ctx.resMessage)
        ctx.channel.close.resolves()
        done()
      })

      describe('object content', function () {
        beforeEach(function (done) {
          ctx.content = {}
          ctx.bufferContent = new Buffer(JSON.stringify({}))
          done()
        })
        it('should make a request and recieve a reply', assertSuccess)
      })
      describe('array content', function () {
        beforeEach(function (done) {
          ctx.content = []
          ctx.bufferContent = new Buffer(JSON.stringify([]))
          done()
        })
        it('should make a request and recieve a reply', assertSuccess)
      })
      describe('string content', function () {
        beforeEach(function (done) {
          ctx.content = 'content'
          ctx.bufferContent = new Buffer('content')
          done()
        })
        it('should make a request and recieve a reply', assertSuccess)
      })
      describe('number content', function () {
        beforeEach(function (done) {
          ctx.content = 22
          ctx.bufferContent = new Buffer('22')
          done()
        })
        it('should make a request and recieve a reply', assertSuccess)
      })
      describe('buffer content', function () {
        beforeEach(function (done) {
          ctx.content = new Buffer('content')
          ctx.bufferContent = ctx.content
          done()
        })
        it('should make a request and recieve a reply', assertSuccess)
      })

      describe('callback api', function () {
        beforeEach(function (done) {
          ctx.content = new Buffer('content')
          ctx.bufferContent = ctx.content
          done()
        })
        it('should make a request and recieve a reply', assertSuccess)
      })

      function assertSuccess (done) {
        ctx.request(ctx.connection, ctx.rpcQueueName, ctx.content, ctx.opts, function (err, resMessage) {
          if (err) { return done(err) }
          expect(resMessage).to.equal(ctx.resMessage)
          sinon.assert.calledOnce(ctx.connection.createChannel)
          sinon.assert.calledOnce(ctx.channel.assertQueue)
          sinon.assert.calledWith(ctx.channel.assertQueue,
            '', put(ctx.opts.queueOpts, { exclusive: true }))
          sinon.assert.calledOnce(ctx.channel.consume)
          sinon.assert.calledWith(ctx.channel.consume,
            ctx.replyQueue.queue, sinon.match.func, put(ctx.opts.consumeOpts, { noAck: true }))
          sinon.assert.calledOnce(ctx.channel.sendToQueue)
          sinon.assert.calledWith(ctx.channel.sendToQueue,
            ctx.rpcQueueName, bufferMatch(ctx.bufferContent), put(ctx.opts.sendOpts, { correlationId: ctx.corrId, replyTo: ctx.replyQueue.queue}))
          sinon.assert.calledOnce(ctx.channel.close)
          done()
        })
      }
    })
  })

  describe('errors', function () {
    describe('invalid connection arg', function () {
      it('should throw error', function (done) {
        ctx.content = 'content'
        expect(function () {
          ctx.request(null, ctx.rpcQueueName, ctx.content, ctx.opts)
        }).to.throw(/connection/)
        expect(function () {
          ctx.request({}, ctx.rpcQueueName, ctx.content, ctx.opts)
        }).to.throw(/connection/)
        done()
      })
    })

    describe('assertQueue error', function () {
      beforeEach(function (done) {
        ctx.err = new Error('boom')
        ctx.connection.createChannel.resolves(ctx.channel)
        ctx.channel.assertQueue.rejects(ctx.err)
        ctx.channel.close.resolves()
        ctx.content = 'content'
        done()
      })

      it('should close connection and yield error', function (done) {
        ctx.request(ctx.connection, ctx.rpcQueueName, ctx.content, ctx.opts)
          .then(function () {
            done(new Error('expected an error'))
          })
          .catch(function (err) {
            expect(err).to.equal(ctx.err)
            sinon.assert.calledOnce(ctx.channel.close)
            done()
          })
          .catch(done)
      })

      describe('channel close occurs first', function () {
        beforeEach(function (done) {
          shimmer.wrap(ctx.channel, 'assertQueue', function (orig) {
            return function () {
              var ret = orig.apply(this, arguments)
              // close the channel
              ctx.channel.emit('close')
              return ret.then(function () {})
            }
          })
          done()
        })

        it('should yield error (channel exit error)', function (done) {
          ctx.request(ctx.connection, ctx.rpcQueueName, ctx.content, ctx.opts)
            .then(function () {
              done(new Error('expected an error'))
            })
            .catch(function (err) {
              expect(err).to.be.an.instanceOf(ChannelCloseError)
              expect(err.message).to.equal('rpc channel closed before receiving the response message')
              expect(err.data).to.deep.equal({
                queue: ctx.rpcQueueName,
                content: ctx.content,
                opts: {
                  sendOpts: put(ctx.opts.sendOpts, {correlationId: ctx.corrId}),
                  queueOpts: put(ctx.opts.queueOpts, {exclusive: true}),
                  consumeOpts: put(ctx.opts.consumeOpts, {noAck: true})
                }
              })
              done()
            })
            .catch(done)
        })
      })
    })

    describe('timeout error', function () {
      beforeEach(function (done) {
        ctx.err = new Error('boom')
        ctx.connection.createChannel.resolves(ctx.channel)
        ctx.channel.assertQueue.resolves(ctx.replyQueue)
        ctx.channel.consume
          .resolves()
          .callsArgWithAsync(1, { properties: {} }) // bs message for coeverage
        ctx.channel.close.resolves()
        ctx.content = 'content'
        done()
      })

      it('should yield a timeout error', function (done) {
        ctx.opts.timeout = 1
        ctx.request(ctx.connection, ctx.rpcQueueName, ctx.content, ctx.opts)
          .then(function () {
            done(new Error('expected an error'))
          })
          .catch(function (err) {
            expect(err).to.exist()
            expect(err).to.be.an.instanceOf(TimeoutError)
            expect(err.data).to.deep.equal({
              queue: ctx.rpcQueueName,
              content: ctx.content,
              opts: {
                timeout: ctx.opts.timeout,
                sendOpts: put(ctx.opts.sendOpts, {correlationId: ctx.corrId, replyTo: ctx.replyQueue.queue}),
                queueOpts: put(ctx.opts.queueOpts, {exclusive: true}),
                consumeOpts: put(ctx.opts.consumeOpts, {noAck: true})
              }
            })
            done()
          })
          .catch(done)
      })
    })
  })
})
