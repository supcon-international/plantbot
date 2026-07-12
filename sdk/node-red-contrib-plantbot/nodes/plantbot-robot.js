// plantbot-robot: registers the robot's factsheet on deploy, then turns each
// incoming msg.payload (pose/battery/mode) into a ~1 Hz state report. The
// state response carries ordersPending — when > 0 the node emits the count on
// its output so a downstream plantbot-orders node can pull immediately.
'use strict'

module.exports = function (RED) {
  function PlantbotRobotNode(config) {
    RED.nodes.createNode(this, config)
    const site = RED.nodes.getNode(config.site)
    const node = this
    if (!site) {
      node.status({ fill: 'red', shape: 'ring', text: 'no site config' })
      return
    }
    const pb = site.client
    const serial = config.serial
    let registered = false

    let streams = []
    try {
      streams = config.streams ? JSON.parse(config.streams) : []
    } catch {
      node.warn('streams is not valid JSON — publishing none')
    }

    async function register() {
      const r = await pb.register({
        serial,
        model: config.model || 'External robot',
        vendor: config.vendor || undefined,
        callsign: config.callsign || undefined,
        family: config.family || undefined,
        level: config.level || 'state-only',
        streams,
      })
      registered = r.ok
      node.status(
        r.ok
          ? { fill: 'green', shape: 'dot', text: `registered ${serial}` }
          : { fill: 'red', shape: 'ring', text: `register failed (${r.status || 'offline'})` },
      )
      return r.ok
    }
    // register on deploy; retry until the platform is reachable
    const retry = setInterval(async () => {
      if (await register()) clearInterval(retry)
    }, 3000)
    void register()

    node.on('input', async (msg, send, done) => {
      if (!registered) await register()
      const s = msg.payload ?? {}
      const r = await pb.state(serial, s)
      if (!r.ok) {
        node.status({ fill: 'yellow', shape: 'ring', text: `state failed (${r.status || 'offline'})` })
        done()
        return
      }
      node.status({ fill: 'green', shape: 'dot', text: `${serial} · ${s.mode ?? 'ok'}` })
      const pending = r.data?.ordersPending ?? 0
      if (pending > 0) send({ topic: 'ordersPending', serial, payload: pending })
      done()
    })

    node.on('close', () => clearInterval(retry))
  }
  RED.nodes.registerType('plantbot-robot', PlantbotRobotNode)
}
