'use strict'

var fs = require('fs')
var os = require('os')
var path = require('path')
var _ = require('@yoda/util')._
var exec = require('child_process').exec
var sync = require('../date-sync').sync
var env = require('@yoda/env')()
var logger = require('logger')('cloudapi')
var property = require('@yoda/property')
var CloudGw = require('@yoda/cloudgw')
var MqttClient = require('./mqtt/client')
var STRINGS = require('../../strings/login.json')

/**
 * This `CloudStore` is the object that provides APIs for connecting
 * Rokid Cloud Service.
 *
 * @constructor
 */
function CloudStore (options) {
  this.apiAvailable = false
  this.cloudgw = null
  this.config = {
    masterId: null,
    deviceId: null,
    deviceTypeId: null,
    key: null,
    secret: null,
    extraInfo: null
  }
  this.options = options || {}
  if (typeof this.options.notify !== 'function') {
    throw new TypeError('options.notify must be a function.')
  }

  this.mqttcli = new MqttClient(this)
}

/**
 * Start connecting to cloud service, which does:
 * - login
 * - bind
 * - sync date from service
 *
 * @method connect
 */
CloudStore.prototype.connect = function connect () {
  this.options.notify('100', STRINGS.LOGIN_DOING)

  var opts = { encoding: 'utf8' }
  return new Promise((resolve, reject) => {
    var handleResponse = this.handleResponse.bind(this)
    var cmd = [
      `nice -n -20 sh ${path.join(__dirname, './login/request.sh')}`,
      `-h ${env.cloudgw.account}`
    ].join(' ')

    exec(cmd, opts, oncomplete)
    function oncomplete (err, stdout, stderr) {
      if (err) {
        return reject(err)
      }
      try {
        var res = JSON.parse(stdout)
        if (!res.success) {
          throw new Error(`cloud login failed ${res.msg}(${res.code})`)
        }
        handleResponse(JSON.parse(res.data))
        return resolve(true)
      } catch (err) {
        logger.error(err)
        return reject(err)
      }
    }
  }).then(() => {
    this.options.notify('101', STRINGS.LOGIN_DONE)
    this.options.notify('201', STRINGS.BIND_MASTER_DONE)
    return this.config
  }, (err) => {
    if (err.code === 'BIND_MASTER_REQUIRED') {
      throw err
    }
    if (err.code === '100006' || err.code === '100007') {
      this.options.notify('101', STRINGS.LOGIN_DONE)
      this.options.notify('-201', STRINGS.BIND_MASTER_FAILURE)
    } else {
      this.options.notify('-101', STRINGS.LOGIN_FAILURE)
    }
    throw err
  })
}

/**
 * @method
 */
CloudStore.prototype.handleResponse = function handleResponse (data) {
  this.config.deviceId = data.deviceId
  this.config.deviceTypeId = data.deviceTypeId
  this.config.key = data.key
  this.config.secret = data.secret
  this.config.extraInfo = data.extraInfo

  // start check the basic info
  var basicInfo = null
  try {
    basicInfo = JSON.parse(this.config.extraInfo.basic_info)
    if (!basicInfo.master) {
      throw new Error('bind master is required')
    } else {
      // everything is ok, just make api available and
      // start initialize mqtt client.
      this.apiAvailable = true
      this.config.masterId = basicInfo.master
      this.cloudgw = new CloudGw(Object.assign({
        host: env.cloudgw.restful
      }, this.config))
      this.syncDate()

      if (!this.options.disableMqtt) {
        this.mqttcli.start({
          forceReconnect: true
        })
      }
    }
  } catch (_) {
    var err = new Error('bind master is required')
    err.code = 'BIND_MASTER_REQUIRED'
    throw err
  }
}

/**
 * @method
 */
CloudStore.prototype.syncDate = function syncDate () {
  fs.readFile('/tmp/LOGIN_HEADER', 'utf8', (err, headers) => {
    if (err || !headers) {
      logger.warn('/tmp/LOGIN_HEADER invalid body, discard sync')
      return
    }
    var lines = headers.split('\r\n')
    logger.info('current response is', lines[0])
    if (!/^HTTP\/1\.1 200/.test(lines[0])) {
      logger.warn('the last response is not 200 status code, discard sync')
      return
    }
    for (var i = 1; i < lines.length; i++) {
      var obj = lines[i].split(':')
      if (obj[0] === 'Date' && typeof obj[1] === 'string') {
        sync(lines[i].replace('Date:', '').trim())
        break
      }
    }
  })
}

/**
 * @method
 */
CloudStore.prototype.reset = function reset () {
  this.apiAvailable = false
  this.cloudgw = null
  this.config = {
    masterId: null,
    deviceId: null,
    deviceTypeId: null,
    key: null,
    secret: null,
    extraInfo: null
  }
  this.mqttcli.suspend()
}

/**
 * @method
 */
CloudStore.prototype.requestMqttToken = function requestMqttToken () {
  if (this.apiAvailable === false) {
    throw new Error('login is required')
  }

  var opts = { encoding: 'utf8' }
  return new Promise((resolve, reject) => {
    var cmd = [
      'nice -n -20',
      `sh ${path.join(__dirname, './login/request-mqtt-token.sh')}`,
      `-k ${this.config.key}`,
      `-s ${this.config.secret}`,
      `-u ${this.config.masterId}`,
      `--device-id ${this.config.deviceId}`,
      `--device-type-id ${this.config.deviceTypeId}`,
      `-h ${env.mqtt.registry}`
    ].join(' ')

    exec(cmd, opts, oncomplete)
    function oncomplete (err, stdout, stderr) {
      if (err) {
        return reject(err)
      }
      try {
        var data = JSON.parse(stdout)
        if (!data.username || !data.token) {
          throw new Error(`request mqtt token failed "${stdout}"`)
        }
        return resolve(data)
      } catch (err) {
        logger.error(err)
        return reject(err)
      }
    }
  })
}

/**
 * @method
 */
CloudStore.prototype.updateBasicInfo = function updateBasicInfo () {
  if (this.apiAvailable === false) {
    throw new Error('api is unavailable, and login is required')
  }

  var networkInterface = _.get(os.networkInterfaces(), 'wlan0', [])
    .filter(it => _.get(it, 'family') === 'IPv4')[0]
  var info = {
    device_id: property.get('ro.boot.serialno'),
    device_type_id: property.get('ro.boot.devicetypeid'),
    ota: property.get('ro.build.version.release'),
    mac: _.get(networkInterface, 'mac'),
    lan_ip: _.get(networkInterface, 'address')
  }
  return new Promise((resolve, reject) => {
    this.cloudgw.request('/v1/device/deviceManager/addOrUpdateDeviceInfo',
      { namespace: 'basic_info', values: info },
      (err, data) => {
        if (err) {
          return reject(err)
        }
        resolve(data)
      })
  })
}

/**
 * @method
 */
CloudStore.prototype.resetSettings = function resetSettings () {
  if (this.apiAvailable === false) {
    throw new Error('api is unavailable, and login is required')
  }

  return new Promise((resolve, reject) => {
    this.cloudgw.request('/v1/device/deviceManager/resetRoki', {},
      (err, data) => {
        if (err) {
          return reject(err)
        }
        resolve(data)
      })
  })
}

/**
 * @method
 */
CloudStore.prototype.sendNlpConform = function sendNlpConform (appId, intent, slot, options, attrs) {
  if (this.apiAvailable === false) {
    throw new Error('api is unavailable, and login is required')
  }

  return new Promise((resolve, reject) => {
    this.cloudgw.request('/v1/skill/dispatch/setConfirm', {
      appId: appId,
      confirmIntent: intent,
      confirmSlot: slot,
      confirmOptions: JSON.stringify(options),
      attributes: JSON.stringify(attrs)
    }, (err, data) => {
      if (err) {
        return reject(err)
      }
      resolve(data)
    })
  })
}

module.exports = CloudStore
