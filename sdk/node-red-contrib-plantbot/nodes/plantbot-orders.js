// plantbot-orders: the order pump. Emits one msg per pulled order on the
// output; accepts settlement reports ({orderId, status, note}) on the input.
// Pulls on a timer AND whenever a plantbot-robot node's ordersPending message
// arrives (wire robot → orders for snappy dispatch).
'use strict'

module.exports = function (RED) {
  function PlantbotOrdersNode(config) {
    RED.nodes.createNode(this, config)
    const site = RED.nodes.getNode(config.site)
    const node = this
    if (!site) {
      node.status({ fill: 'red', shape: 'ring', text: 'no site config' })
      return
    }
    const pb = site.client
    const serial = config.serial
    let pulling = false
    // de-dupe by order.id (bounded ring) — the platform re-serves acked-but-
    // unsettled orders (e.g. across a restart), so without this the same order
    // would be emitted on every poll. Mirrors the TS SDK pump's dedup.
    const seen = new Set()
    const seenRing = []
    const SEEN_CAP = 500
    function firstSight(id) {
      if (seen.has(id)) return false
      seen.add(id)
      seenRing.push(id)
      if (seenRing.length > SEEN_CAP) seen.delete(seenRing.shift())
      return true
    }

    async function pull() {
      if (pulling) return
      pulling = true
      try {
        const r = await pb.pullOrders(serial)
        if (!r.ok) {
          node.status({ fill: 'yellow', shape: 'ring', text: `pull failed (${r.status || 'offline'})` })
          return
        }
        const orders = (r.data?.orders ?? []).filter((o) => firstSight(o.id))
        if (orders.length) node.status({ fill: 'green', shape: 'dot', text: `${orders.length} order(s)` })
        for (const order of orders) node.send({ topic: order.kind, serial, payload: order })
      } finally {
        pulling = false
      }
    }

    const everyS = Number(config.intervalS || 5)
    const timer = everyS > 0 ? setInterval(pull, everyS * 1000) : undefined

    node.on('input', async (msg, _send, done) => {
      const p = msg.payload
      if (p && typeof p === 'object' && p.orderId && p.status) {
        // settlement report
        const r = await pb.orderStatus(p.orderId, p.status, p.note)
        node.status(
          r.ok
            ? { fill: 'green', shape: 'dot', text: `${p.orderId} ${p.status}` }
            : { fill: 'yellow', shape: 'ring', text: `settle failed (${r.status || 'offline'})` },
        )
      } else {
        // anything else (e.g. a robot node's ordersPending ping) → pull now
        await pull()
      }
      done()
    })

    node.on('close', () => timer && clearInterval(timer))
  }
  RED.nodes.registerType('plantbot-orders', PlantbotOrdersNode)
}
