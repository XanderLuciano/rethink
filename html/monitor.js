// ── Device monitor page ──────────────────────────────────────────────
const DEVICE_ID = new URLSearchParams(window.location.search).get('id')

const FRIENDLY = {
    WMVEL2137: 'Microwave / Hood',
    WLDGL6924: 'Gas Range',
    '2REF11EBIW__4': 'Refrigerator',
    N15: 'Dishwasher',
}

// Control commands for known devices
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
    fan: false,
    light: false,
    rssi: null,
    lastSeen: null,
    packetCount: 0,
}
let metaCache = null
let ws, reconnectTimer

const $ = (id) => document.getElementById(id)
const ts = () => new Date().toLocaleTimeString()

// ── Packet parsing ───────────────────────────────────────────────────
function parseState(hex) {
    const lower = hex.toLowerCase()
    // Microwave AA62 status: byte at offset 7 in hex = '0'/'1' for fan
    if (hex.startsWith('aa62')) {
        const fan = hex.length > 14 ? hex[14] === '3' && hex[15] === '1' : false
        // Light: look for 5310 pattern in second block (after second ff030d)
        const ffIdx = lower.lastIndexOf('ff030d')
        let light = false
        if (ffIdx > 0) {
            const tail = lower.substring(ffIdx + 6)
            const c3Idx = tail.indexOf('c3')
            if (c3Idx >= 0) {
                const blk = tail.substring(c3Idx)
                const m = blk.match(/53([0-9a-f]{2})/)
                if (m) light = parseInt(m[1], 16) === 0x10
            }
        }
        return { fan, light }
    }
    return {}
}

// ── UI updates ───────────────────────────────────────────────────────
function update() {
    const name = FRIENDLY[device.model] || device.model || DEVICE_ID.substring(0, 8)
    $('dev_title').innerText = name + ' Monitor'

    $('info_model').innerText = device.model || (metaCache ? metaCache.modelId : '...')
    $('info_type').innerText = device.deviceType || (metaCache ? metaCache.deviceType : '...') || '?'
    $('info_status').innerHTML =
        device.status === 'online'
            ? '<span class="green-text">● Online</span>'
            : device.status === 'connecting'
              ? '<span class="orange-text">◐ Connecting...</span>'
              : '<span class="red-text">○ Offline</span>'
    $('info_rssi').innerText = device.rssi != null ? device.rssi + ' dBm' : '...'
    $('info_packets').innerText = device.packetCount
    if (device.lastSeen) {
        const ago = Math.round((Date.now() - device.lastSeen) / 1000)
        $('info_seen').innerText = ago < 60 ? ago + 's ago' : Math.round(ago / 60) + 'm ago'
    } else {
        $('info_seen').innerText = '---'
    }

    updateCards()
    updateControls()
}

function updateCards() {
    const isMicrowave = device.model === 'WMVEL2137' || (metaCache && metaCache.modelId === 'WMVEL2137')

    if (isMicrowave) {
        $('status_cards').innerHTML = `
            <div class="col s6 m3">
                <div class="state-card">
                    <div class="card-header"><span class="material-icons">air</span> Vent Fan</div>
                    <div class="card-value">${device.fan ? 'ON' : 'OFF'}</div>
                    <div class="card-sub">${device.fan ? 'Running' : 'Stopped'}</div>
                </div>
            </div>
            <div class="col s6 m3">
                <div class="state-card">
                    <div class="card-header"><span class="material-icons">light_mode</span> Light</div>
                    <div class="card-value">${device.light ? 'ON' : 'OFF'}</div>
                    <div class="card-sub">${device.light ? 'Illuminated' : 'Dark'}</div>
                </div>
            </div>`
    } else {
        $('status_cards').innerHTML = `
            <div class="col s12">
                <div class="state-card">
                    <div class="card-header"><span class="material-icons">devices</span> Device streaming raw data to HA</div>
                    <div class="card-sub">Unknown model "${device.model || '?'}" — generic packet capture active. See Raw Packets below for TLV hex.</div>
                </div>
            </div>`
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
                    onclick="toggle('fan')">Fan: ${device.fan ? 'ON' : 'OFF'}</button>
        </div>
        <div class="col s6 m3">
            <button class="toggle-btn ${device.light ? 'on' : 'off'} waves-effect"
                    id="btn_light" ${!online ? 'disabled' : ''}
                    onclick="toggle('light')">Light: ${device.light ? 'ON' : 'OFF'}</button>
        </div>`
}

function toggle(ctrl) {
    const cmds = DEVICE_CMDS[device.model]
    if (!cmds || !ws || ws.readyState !== WebSocket.OPEN) return
    const on = device[ctrl]
    const hex = cmds[ctrl + (on ? '_off' : '_on')]
    if (!hex) return
    ws.send(JSON.stringify({ sendToDevice: hex }))
    device[ctrl] = !on
    update()
}

function pushRaw(dir, hex) {
    device.packetCount++
    const div = document.createElement('div')
    div.className = `msg ${dir}`
    div.innerHTML = `<span class="time">${ts()}</span><span class="dir">${dir === 'rx' ? '◀' : '▶'}</span>${hex}`
    const log = $('raw_log')
    if (log.querySelector('div[style]')) log.innerHTML = '' // clear placeholder
    log.appendChild(div)
    log.scrollTop = log.scrollHeight
    $('raw_count').innerText = device.packetCount
    // Trim old messages
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
            update()
        }

        if (json.rx) {
            pushRaw('rx', json.rx)
            if (json.rssi != null) device.rssi = json.rssi
            device.lastSeen = Date.now()

            // Parse state from raw hex
            const state = parseState(json.rx)
            if (Object.keys(state).length) {
                Object.assign(device, state)
                update()
            }
        }

        if (json.tx) {
            pushRaw('tx', json.tx)
        }
    }
}

// ── Init ─────────────────────────────────────────────────────────────
connect()
