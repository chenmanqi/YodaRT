'use strict'

module.exports = function (light, data, callback) {
  var pos = Math.floor((data.volume / 100) * light.ledsConfig.leds)
  light.clear()
  var player = light.sound('system://volume.wav')
  for (var i = 0; i < pos; i++) {
    light.pixel(i, 255, 255, 255)
  }
  light.render()
  light.requestAnimationFrame(() => {
    light.stop()
  }, 2000)

  return {
    stop: function (keep) {
      player.stop()
      light.stop(keep)
    }
  }
}
