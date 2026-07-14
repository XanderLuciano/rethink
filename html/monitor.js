// ── Device monitor page ──────────────────────────────────────────────
const DEVICE_ID = new URLSearchParams(window.location.search).get('id')

const FRIENDLY = {
    WMVEL2137: 'Microwave / Hood',
    WLDGL6924: 'Gas Range',
    '2REF11EBIW__4': 'Refrigerator',
    N15: 'Dishwasher',
}

const DEVICE_CMDS = {
    WMVEL2137: {
        fan_on: 'aa0ef0432204010100808080c6bb',
        fan_off: 'aa0ef0432204000000808080c4bb',
        light_on: 'aa0ef0432204008001018080c6bb',
        light_off: 'aa0ef0432204008000008080c4bb',
    },
}

let device = {
    status: 'connecting',
    model: '',
    deviceType: '',
    swVer: '',
    fan: false,
    fanLevel: 'off',
    light: false,
    lightLevel: null,
    rssi: null,
    lastSeen: null,
    packetCount: 0,
}
let metaCache = null
let ws, reconnectTimer, seenTimer

const $ = (id) => document.getElementById(id)
const ts = () => new Date().toLocaleTimeString()

// ── Packet parsing ───────────────────────────────────────────────────
function parseState(hex) {
    const lower = hex.toLowerCase()
    if (hex.startsWith('aa62')) {
        let state = {}
        const ffIdx = lower.lastIndexOf('ff030d')
        if (ffIdx > 0) {
            const tail = lower.substring(ffIdx + 6)
            const c3Idx = tail.indexOf('c3')
            if (c3Idx >= 0) {
                const blk = tail.substring(c3Idx)
                const m = blk.match(/53([0-9a-f]{2})/)
                if (m) {
                    const val = parseInt(m[1], 16)
                    // Lower nibble: fan level (0=off, 1=low, 2=med, 3=high, 4=turbo)
                    // Upper nibble: light (0=off, 1=low, 2=high)
                    const fanVal = val & 0x0f
                    const lightVal = (val >> 4) & 0x0f
                    state.fan = fanVal > 0
                    state.fanLevel = ['off', 'low', 'medium', 'high', 'turbo'][fanVal] || 'off'
                    state.light = lightVal > 0
                    state.lightLevel = lightVal === 2 ? 'high' : lightVal === 1 ? 'low' : null
                }
            }
        }
        return state
    }
    return {}
}

// ── UI updates ───────────────────────────────────────────────────────
function update() {
    const name = FRIENDLY[device.model] || device.model || DEVICE_ID.substring(0, 8)
    $('dev_title').innerText = name + ' Monitor'

    $('info_model').innerText = device.model || (metaCache ? metaCache.modelId : '...')
    $('info_type').innerText = device.deviceType || (metaCache ? metaCache.deviceType : '...') || '?'
    $('info_fw').innerText = device.swVer || (metaCache ? metaCache.swVersion : '') || '?'
    $('info_status').innerHTML =
        device.status === 'online'
            ? '<span class="green-text">● Online</span>'
            : device.status === 'connecting'
              ? '<span class="orange-text">◐ Connecting...</span>'
              : '<span class="red-text">○ Offline</span>'
    $('info_rssi').innerText = device.rssi != null ? device.rssi + ' dBm' : '...'
    $('info_packets').innerText = device.packetCount
    updateSeen()

    updateCards()
    updateControls()
}

function updateSeen() {
    if (device.lastSeen) {
        const ago = Math.round((Date.now() - device.lastSeen) / 1000)
        $('info_seen').innerText = ago < 60 ? ago + 's ago' : Math.round(ago / 60) + 'm ago'
    } else {
        $('info_seen').innerText = '---'
    }
}

function updateCards() {
    const isMicrowave = device.model === 'WMVEL2137' || (metaCache && metaCache.modelId === 'WMVEL2137')
    if (isMicrowave) {
        $('status_cards').innerHTML = `
            <div class="col s6 m3"><div class="state-card">
                <div class="card-header"><span class="material-icons">air</span> Vent Fan</div>
                <div class="card-value">${device.fan ? device.fanLevel.toUpperCase() : 'OFF'}</div>
                <div class="card-sub">${device.fan ? 'Speed ' + device.fanLevel : 'Stopped'}</div>
            </div></div>
            <div class="col s6 m3"><div class="state-card">
                <div class="card-header"><span class="material-icons">light_mode</span> Light</div>
                <div class="card-value">${device.light ? (device.lightLevel === 'high' ? 'HIGH' : 'ON') : 'OFF'}</div>
                <div class="card-sub">${device.light ? (device.lightLevel === 'high' ? 'Bright' : 'Dim') : 'Dark'}</div>
            </div></div>`
    } else {
        $('status_cards').innerHTML = `
            <div class="col s12"><div class="state-card">
                <div class="card-header"><span class="material-icons">devices</span> Device streaming raw data to HA</div>
                <div class="card-sub">Unknown model "${device.model || '?'}" — generic packet capture active. Raw hex below.</div>
            </div></div>`
    }
}

function updateControls() {
    const cmds = DEVICE_CMDS[device.model] || DEVICE_CMDS[metaCache?.modelId]
    if (!cmds) {
        $('controls_section').style.display = 'none'
        return
    }
    $('controls_section').style.display = ''
    const online = device.status === 'online'

    $('controls_row').innerHTML = `
        <div class="col s6 m3">
            <button class="toggle-btn ${device.fan ? 'on' : 'off'} waves-effect"
                    id="btn_fan" ${!online ? 'disabled' : ''}
                    onclick="toggle('fan')">Fan: ${device.fan ? device.fanLevel.toUpperCase() : 'OFF'}</button>
        </div>
        <div class="col s6 m3">
            <button class="toggle-btn ${device.light ? 'on' : 'off'} waves-effect"
                    id="btn_light" ${!online ? 'disabled' : ''}
                    onclick="toggle('light')">Light: ${device.light ? (device.lightLevel === 'high' ? 'HIGH' : 'LOW') : 'OFF'}</button>
        </div>`

    // Enable/disable send button
    $('btn_send').disabled = !online
}

function toggle(ctrl) {
    const cmds = DEVICE_CMDS[device.model]
    if (!cmds || !ws || ws.readyState !== WebSocket.OPEN) return

    if (ctrl === 'light') {
        // Cycle: off → low → high → off
        if (!device.light) {
            ws.send(JSON.stringify({ sendToDevice: cmds.light_on }))
        } else if (device.lightLevel === 'low') {
            ws.send(JSON.stringify({ sendToDevice: cmds.light_on }))
        } else {
            ws.send(JSON.stringify({ sendToDevice: cmds.light_off }))
        }
    } else if (ctrl === 'fan') {
        // Cycle: off → low → medium → high → turbo → off
        if (device.fanLevel === 'turbo') {
            ws.send(JSON.stringify({ sendToDevice: cmds.fan_off }))
        } else {
            ws.send(JSON.stringify({ sendToDevice: cmds.fan_on }))
        }
    } else {
        const on = device[ctrl]
        const hex = cmds[ctrl + (on ? '_off' : '_on')]
        if (!hex) return
        ws.send(JSON.stringify({ sendToDevice: hex }))
    }
}

function sendCmd() {
    const hex = $('cmd_input').value.trim()
    if (!hex || !ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ sendToDevice: hex }))
    $('cmd_input').value = ''
    // Allow enter key too
}

// ── Raw packet logging ───────────────────────────────────────────────
function pushRaw(dir, hex) {
    device.packetCount++
    const div = document.createElement('div')
    div.className = `msg ${dir}`
    div.innerHTML = `<span class="time">${ts()}</span><span class="dir">${dir === 'rx' ? '◀ DEV' : '▶ CLOUD'}</span>${hex}`
    const log = $('raw_log')
    if (log.querySelector('div[style]')) log.innerHTML = '' // clear placeholder
    log.appendChild(div)
    log.scrollTop = log.scrollHeight
    $('raw_count').innerText = device.packetCount
    while (log.children.length > 200) log.firstChild.remove()
}

// ── WebSocket ────────────────────────────────────────────────────────
function connect() {
    clearTimeout(reconnectTimer)
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${wsProto}//${window.location.host}/device?id=${DEVICE_ID}`)

    ws.onclose = () => {
        device.status = 'offline'
        update()
        reconnectTimer = setTimeout(connect, 5000)
    }

    ws.onopen = () => {
        device.status = 'connecting'
        update()
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        const json = JSON.parse(ev.data)

        if (json.status) {
            device.status = json.status
            update()
        }

        if (json.meta) {
            metaCache = json.meta
            device.model = json.meta.modelId || ''
            device.deviceType = json.meta.deviceType || ''
            device.swVer = json.meta.swVersion || ''
            update()
        }

        if (json.rx) {
            pushRaw('rx', json.rx)
            if (json.rssi != null) device.rssi = json.rssi
            device.lastSeen = Date.now()

            const state = parseState(json.rx)
            if (Object.keys(state).length) Object.assign(device, state)
            update() // always refresh — RSSI/packets/seen change every packet
        }

        if (json.tx) {
            pushRaw('tx', json.tx)
            update()
        }
    }

    // Refresh "last seen" counter periodically
    clearInterval(seenTimer)
    seenTimer = setInterval(updateSeen, 5000)
}

// ── Init ─────────────────────────────────────────────────────────────
$('cmd_input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCmd()
})
connect()
