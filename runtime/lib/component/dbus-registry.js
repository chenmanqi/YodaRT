var dbus = require('dbus')
var EventEmitter = require('events')
var util = require('util')
var path = require('path')

var logger = require('logger')('dbus')
var _ = require('@yoda/util')._
var AudioManager = require('@yoda/audio').AudioManager

var DbusRemoteCall = require('../dbus-remote-call')
var dbusConfig = require('/etc/yoda/dbus-config.json')

module.exports = DBus
function DBus (runtime) {
  EventEmitter.call(this)
  this.runtime = runtime
}
util.inherits(DBus, EventEmitter)

DBus.prototype.init = function init () {
  var service = dbus.registerService('session', dbusConfig.service)
  this.service = service

  ;['extapp', 'prop', 'amsexport', 'yodadebug'].forEach(namespace => {
    if (typeof this[namespace] !== 'object') {
      throw new TypeError(`Expect object on component.dbus.prototype.${namespace}.`)
    }

    var object = service.createObject(dbusConfig[namespace].objectPath)
    var iface = object.createInterface(dbusConfig[namespace].interface)

    Object.keys(this[namespace]).forEach(method => {
      var descriptor = this[namespace][method]
      iface.addMethod(method, {
        in: descriptor.in,
        out: descriptor.out
      }, descriptor.fn.bind(this))
    })
  })

  this.listenSignals()
}

DBus.prototype.destruct = function destruct () {

}

DBus.prototype.callMethod = function callMethod (
  serviceName, objectPath, interfaceName,
  member, args) {
  return new Promise((resolve, reject) => {
    var sig = args.map((arg) => {
      if (typeof arg === 'boolean') {
        return 'b'
      } else {
        return 's'
      }
    }).join('')
    this.service._dbus.callMethod(
      serviceName,
      objectPath,
      interfaceName,
      member, sig, args, resolve)
  })
}

DBus.prototype.listenSignals = function listenSignals () {
  var self = this
  var proxy = new DbusRemoteCall(this.service._bus)
  var ttsEvents = {
    'ttsdevent': function onTtsEvent (msg) {
      var channel = `callback:tts:${_.get(msg, 'args.0')}`
      logger.info(`VuiDaemon received ttsd event on channel(${channel})`)
      EventEmitter.prototype.emit.apply(
        self,
        [ channel ].concat(msg.args.slice(1))
      )
    }
  }
  proxy.listen(
    'com.service.tts',
    '/tts/service',
    'tts.service',
    function onTtsEvent (msg) {
      var handler = ttsEvents[msg && msg.name]
      if (handler == null) {
        logger.warn(`Unknown ttsd event type '${msg && msg.name}'.`)
        return
      }
      handler(msg)
    }
  )

  var multimediaEvents = {
    'multimediadevent': function onMultimediaEvent (msg) {
      var channel = `callback:multimedia:${_.get(msg, 'args.0')}`
      logger.info(`VuiDaemon received multimediad event on channel(${channel})`)
      EventEmitter.prototype.emit.apply(
        self,
        [ channel ].concat(msg.args.slice(1))
      )
    }
  }
  proxy.listen(
    'com.service.multimedia',
    '/multimedia/service',
    'multimedia.service',
    function onMultimediaEvent (msg) {
      var handler = multimediaEvents[msg && msg.name]
      if (handler == null) {
        logger.warn(`Unknown multimediad event type '${msg && msg.name}'.`)
        return
      }
      handler(msg)
    }
  )
}

DBus.prototype.extapp = {
  register: {
    in: ['s', 's', 's'],
    out: ['b'],
    fn: function register (appId, objectPath, ifaceName, cb) {
      logger.info('dbus registering app', appId, objectPath, ifaceName)
      if (!this.runtime.custodian.isPrepared()) {
        /** prevent app to invoke runtime methods if runtime is not logged in yet */
        return cb(null, false)
      }
      try {
        this.runtime.registerDbusApp(appId, objectPath, ifaceName)
      } catch (err) {
        logger.error('Unexpected error on registering dbus app', appId, err && err.stack)
        return cb(null, false)
      }
      cb(null, true)
    }
  },
  destroy: {
    in: ['s'],
    out: [],
    fn: function destroy (appId, cb) {
      this.runtime.deleteDbusApp(appId)
      cb(null)
    }
  },
  start: {
    in: ['s', 's'],
    out: [],
    fn: function start (appId, form, cb) {
      if (typeof form === 'function') {
        cb = form
        form = null
      }
      logger.info('on start', Array.prototype.slice.call(arguments, 0))
      this.runtime.life.createApp(appId)
        .then(() => {
          logger.info(`activating dbus app '${appId}'`)
          this.runtime.updateCloudStack(appId, 'cut')
          return this.runtime.life.activateAppById(appId, form)
        })
        .then(
          () => cb(null),
          err => logger.error(`Unexpected error on foregrounding app '${appId}'`, err.stack)
        )
    }
  },
  exit: {
    in: ['s'],
    out: [],
    fn: function exit (appId, cb) {
      if (appId !== this.runtime.life.getCurrentAppId()) {
        logger.log('exit app permission deny')
        return cb(null)
      }
      this.runtime.exitAppById(appId)
      cb(null)
    }
  },
  tts: {
    in: ['s', 's'],
    out: ['s'],
    fn: function tts (appId, text, cb) {
      if (this.runtime.loader.getAppManifest(appId) == null) {
        return cb(null, '-1')
      }
      var permit = this.runtime.permission.check(appId, 'ACCESS_TTS')
      if (!permit) {
        return cb(null, '-1')
      }
      this.runtime.ttsMethod('speak', [appId, text])
        .then((res) => {
          var ttsId = res[0]
          cb(null, ttsId)
          if (ttsId === '-1') {
            return
          }

          var channel = `callback:tts:${ttsId}`
          var app = this.runtime.scheduler.getAppById(appId)
          this.on(channel, event => {
            if (['end', 'cancel', 'error'].indexOf(event) < 0) {
              return
            }
            this.removeAllListeners(channel)
            this.service._dbus.emitSignal(
              app.objectPath,
              app.ifaceName,
              'onTtsComplete',
              's',
              [ttsId]
            )
          })
        })
    }
  },
  media: {
    in: ['s'],
    out: ['s'],
    fn: function media (appId, url, cb) {
      if (this.runtime.loader.getAppManifest(appId) == null) {
        return cb(null, '-1')
      }
      var permit = this.runtime.permission.check(appId, 'ACCESS_MULTIMEDIA')
      if (!permit) {
        return cb(null, '-1')
      }
      this.runtime.multimediaMethod('start', [appId, url, 'playback'])
        .then((result) => {
          var multimediaId = _.get(result, '0', '-1')
          logger.log('create media player', multimediaId)

          cb(null, multimediaId)
          if (multimediaId === '-1') {
            return
          }

          var channel = `callback:multimedia:${multimediaId}`
          var app = this.runtime.scheduler.getAppById(appId)
          this.on(channel, event => {
            if (['playbackcomplete', 'cancel', 'error'].indexOf(event) < 0) {
              return
            }
            this.removeAllListeners(channel)
            this.service._dbus.emitSignal(
              app.objectPath,
              app.ifaceName,
              'onMediaComplete',
              's',
              [multimediaId]
            )
          })
        })
    }
  }
}

DBus.prototype.prop = {
  all: {
    in: ['s'],
    out: ['s'],
    fn: function all (appId, cb) {
      var config = this.runtime.onGetPropAll()
      cb(null, JSON.stringify(config))
    }
  }
}

DBus.prototype.amsexport = {
  ReportSysStatus: {
    in: ['s'],
    out: ['b'],
    fn: function ReportSysStatus (status, cb) {
      if (this.runtime.loadAppComplete === false) {
        // waiting for the app load complete
        return cb(null, false)
      }
      try {
        var data = JSON.parse(status)
        cb(null, true)

        if (data.upgrade === true) {
          this.runtime.startApp('@upgrade', {}, {})
        } else if (this.runtime.custodian.isConfiguringNetwork()) {
          logger.info('recevice message with data', data)
          var filter = [
            'CTRL-EVENT-SCAN-STARTED',
            'CTRL-EVENT-SCAN-RESULTS',
            'CTRL-EVENT-SUBNET-STATUS-UPDATE'
          ]
          if (data.msg && filter.indexOf(data.msg) === -1) {
            this.runtime.openUrl(
              `yoda-skill://network/wifi_status?status=${data.msg}&value=${data.data}`, {
                preemptive: false
              })
          }
        }
        if (data['Network'] === true) {
          this.runtime.custodian.onNetworkConnect()
        } else if (!this.runtime.custodian.isConfiguringNetwork() &&
          (data['Network'] === false || data['Wifi'] === false)) {
          this.runtime.custodian.onNetworkDisconnect()
        }
      } catch (err) {
        logger.error(err && err.stack)
        cb(null, false)
      }
    }
  },
  SetTesting: {
    in: ['s'],
    out: ['b'],
    fn: function SetTesting (testing, cb) {
      logger.log('set testing' + testing)
      cb(null, true)
    }
  },
  SendIntentRequest: {
    in: ['s', 's', 's'],
    out: ['b'],
    fn: function SendIntentRequest (asr, nlp, action, cb) {
      console.log('sendintent', asr, nlp, action)
      this.runtime.turen.handleEvent('nlp', {
        asr: asr,
        nlp: nlp,
        action: action
      })
      cb(null, true)
    }
  },
  Reload: {
    in: [],
    out: ['b'],
    fn: function Reload (cb) {
      cb(null, true)
    }
  },
  Ping: {
    in: [],
    out: ['b'],
    fn: function PIng (cb) {
      logger.log('YodaOS is alive')
      cb(null, true)
    }
  },
  ForceUpdateAvailable: {
    in: [],
    out: [],
    fn: function ForceUpdateAvailable (cb) {
      logger.info('force update available, waiting for incoming voice')
      this.runtime.forceUpdateAvailable = true
      cb(null)
    }
  },
  Relogin: {
    in: [],
    out: [],
    fn: function Relogin (cb) {
      this.runtime.custodian.onLogout()
      this.runtime.reconnect()
        .then(
          () => {
            cb()
          },
          err => {
            logger.error('unexpected error on re-login', err.stack)
            cb()
          }
        )
    }
  },
  Hibernate: {
    in: [],
    out: ['s'],
    fn: function Hibernate (cb) {
      this.runtime.hibernate()
        .then(
          () => cb(null, '{"ok": true}'),
          err => {
            logger.error('unexpected error on deactivating apps in stack', err.stack)
            cb(null, JSON.stringify({ ok: false, error: err.message }))
          }
        )
    }
  },
  GetVolume: {
    in: [],
    out: ['s'],
    fn: function GetVolume (cb) {
      cb(null, JSON.stringify({ ok: true, result: AudioManager.getVolume() }))
    }
  },
  SetVolume: {
    in: ['d'],
    out: ['s'],
    fn: function SetVolume (val, cb) {
      this.runtime.openUrl(`yoda-skill://volume/set_volume?value=${val}`, { preemptive: false })
        .then(
          () => cb(null, JSON.stringify({ ok: true, result: AudioManager.getVolume() })),
          err => {
            logger.error('unexpected error on set volume', err.stack)
            cb(null, JSON.stringify({ ok: false, error: err.message }))
          }
        )
    }
  },
  IncreaseVolume: {
    in: [],
    out: ['s'],
    fn: function IncreaseVolume (cb) {
      this.runtime.openUrl('yoda-skill://volume/volume_up', { preemptive: false })
        .then(
          () => cb(null, JSON.stringify({ ok: true, result: AudioManager.getVolume() })),
          err => {
            logger.error('unexpected error on increase volume', err.stack)
            cb(null, JSON.stringify({ ok: false, error: err.message }))
          }
        )
    }
  },
  DecreaseVolume: {
    in: [],
    out: ['s'],
    fn: function DecreaseVolume (cb) {
      this.runtime.openUrl('yoda-skill://volume/volume_down', { preemptive: false })
        .then(
          () => cb(null, JSON.stringify({ ok: true, result: AudioManager.getVolume() })),
          err => {
            logger.error('unexpected error on decrease volume', err.stack)
            cb(null, JSON.stringify({ ok: false, error: err.message }))
          }
        )
    }
  },
  GetSpeakerMuted: {
    in: [],
    out: ['s'],
    fn: function GetSpeakerMuted (cb) {
      cb(null, JSON.stringify({
        ok: true,
        result: AudioManager.isMuted() || AudioManager.getVolume() === 0
      }))
    }
  },
  SetSpeakerMute: {
    in: ['b'],
    out: ['s'],
    fn: function SetSpeakerMute (mute, cb) {
      var url = mute ? 'yoda-skill://volume/mute' : 'yoda-skill://volume/unmute'
      this.runtime.openUrl(url, { preemptive: false })
        .then(
          () => cb(null, '{"ok": true}'),
          err => {
            logger.error('unexpected error on decrease volume', err.stack)
            cb(null, JSON.stringify({ ok: false, error: err.message }))
          }
        )
    }
  },
  GetMicrophoneMuted: {
    in: [],
    out: ['s'],
    fn: function GetMicrophoneMuted (cb) {
      cb(null, JSON.stringify({
        ok: true,
        result: this.runtime.turen.muted
      }))
    }
  },
  SetMicrophoneMute: {
    in: ['b'],
    out: ['s'],
    fn: function SetMicrophoneMute (mute, cb) {
      this.runtime.setMicMute(mute)
        .then(
          () => cb(null, '{"ok": true}'),
          err => {
            logger.error('unexpected error on set speaker mute', err.stack)
            cb(null, JSON.stringify({ ok: false, error: err.message }))
          }
        )
    }
  },
  TextNLP: {
    in: ['s'],
    out: ['s'],
    fn: function TextNLP (text, cb) {
      this.runtime.flora.getNlpResult(text, (err, nlp, action) => {
        if (err) {
          logger.error('Unexpected error on get nlp for asr', text, err.stack)
          return cb(null, JSON.stringify({ ok: false, error: err.message }))
        }
        this.runtime.onVoiceCommand(text, nlp, action)
          .then(
            () => cb(null, '{"ok":true}'),
            err => {
              logger.error('unexpected error on voice command', err.stack)
              cb(null, JSON.stringify({ ok: false, error: err.message }))
            }
          )
      })
    }
  }
}

DBus.prototype.yodadebug = {
  GetLifetime: {
    in: [],
    out: ['s'],
    fn: function (cb) {
      cb(null, JSON.stringify({
        ok: true,
        result: {
          activeSlots: this.runtime.life.activeSlots,
          appDataMap: this.runtime.life.appDataMap,
          backgroundAppIds: this.runtime.life.backgroundAppIds,
          carrierId: this.runtime.life.carrierId,
          monopolist: this.runtime.life.monopolist,
          appIdOnPause: this.runtime.life.appIdOnPause,
          cloudAppStack: this.runtime.domain,
          appStatus: this.runtime.scheduler.appStatus
        }
      }))
    }
  },
  GetTurenState: {
    in: [],
    out: ['s'],
    fn: function (cb) {
      var ret = { ok: true, result: {} }
      var keys = [
        'muted',
        'awaken',
        'asrState',
        'pickingUp',
        'pickingUpDiscardNext',
        'solitaryVoiceComingTimeout',
        'noVoiceInputTimeout'
      ]
      keys.forEach(key => {
        ret.result[key] = this.runtime.turen[key]
        if (ret.result[key] === undefined) {
          ret.result[key] = null
        }
      })
      cb(null, JSON.stringify(ret))
    }
  },
  mockAsr: {
    in: ['s'],
    out: ['s'],
    fn: function mockAsr (asr, cb) {
      if (typeof asr === 'function') {
        cb = asr
        asr = ''
      }
      var floraEmit = (channel, args, ms) => {
        setTimeout(() => {
          this.runtime.flora.__cli.callbacks[0](channel, '', {
            get: (idx) => _.get(args, idx)
          })
        }, ms)
      }
      floraEmit('rokid.turen.voice_coming', [], 0)
      floraEmit('rokid.turen.local_awake', [0], 100)
      floraEmit('rokid.turen.start_voice', [], 150)
      floraEmit('rokid.speech.inter_asr', ['若琪'], 200)
      if (asr) {
        floraEmit('rokid.speech.final_asr', [asr], 250)
        this.runtime.flora.getNlpResult(asr, (err, nlp, action) => {
          if (err) {
            return logger.error('Unexpected error on get nlp for asr', asr, err.stack)
          }
          cb(null, JSON.stringify({ ok: true, result: { nlp: nlp, action: action } }))
          floraEmit('rokid.speech.nlp', [JSON.stringify(nlp), JSON.stringify(action)], 300)
        })
      } else {
        floraEmit('rokid.speech.extra', ['{"activation": "fake"}'], 250)
      }
      floraEmit('rokid.turen.end_voice', [], 300)
      if (!asr) {
        cb(null, JSON.stringify({ ok: true, result: null }))
      }
    }
  },
  mockKeyboard: {
    in: ['s'],
    out: ['s'],
    fn: function fn (cmdStr, cb) {
      var cmd
      try {
        cmd = JSON.parse(cmdStr)
      } catch (err) {
        return cb(null, JSON.stringify({ ok: false, message: err.message, stack: err.stack }))
      }
      this.runtime.keyboard.input.emit(cmd.event, { keyCode: cmd.keyCode, keyTime: cmd.keyTime })
      return cb(null, JSON.stringify({ ok: true, result: null }))
    }
  },
  doProfile: {
    in: ['s', 'n'],
    out: ['s'],
    fn: function DoProfile (storePath, duration, cb) {
      if (!path.isAbsolute(storePath)) {
        cb(null, `store path ${storePath} should be absolute`)
        return
      }
      try {
        var profiler = require('profiler')
        profiler.startProfiling(storePath, duration)
        setTimeout(function () {
          cb(null, `finished, store path ${storePath}`)
        }, duration * 1000)
      } catch (err) {
        cb(err)
      }
    }
  },
  reportMemoryUsage: {
    in: [],
    out: ['s'],
    fn: function ReportMemoryUsage (cb) {
      cb(null, JSON.stringify(process.memoryUsage()))
    }
  }
}
