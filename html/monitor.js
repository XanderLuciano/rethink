// ── Device monitor page ──────────────────────────────────────────────
const DEVICE_ID = new URLSearchParams(window.location.search).get('id')
const baseUrl = new URL(window.location)
baseUrl.search = ''
baseUrl.hash = ''

// ── Friendly names & device config ───────────────────────────────────
const FRIENDLY = {
    WMVEL2137: 'Microwave / Hood',
    WLDGL6924: 'Gas Range',
    '2REF11EBIW__4': 'Refrigerator',
    N15: 'Dishwasher',
}

// Device control configurations (modelId -> controls)
const DEVICE_CONTROLS = {
    WMVEL2137: {
        controls: [
            { id: 'fan', label: 'Vent Fan', icon: 'air', topic: 'lime' },
            { id: 'light', label: 'Light', icon: 'light_mode', topic: 'lime' },
        ],
        cmds: {
            fan_on: 'aa0ef0432204010100808080c6bb',
            fan_off: 'aa0ef0432204000000808080c4bb',
            light_on: 'aa0ef0432204008001018080c6bb',
            light_off: 'aa0ef0432204008000008080c4bb',
        },
        stateParser: parseMicrowaveState,
    },
}

// ── Device state ─────────────────────────────────────────────────────
let deviceState = {
    status: 'connecting',
    model: '',
    deviceType: '',
    meta: null,
    fan: false,
    light: false,
    lastSeen: null,
    rssi: null,
}

let rawMessages = []
let ws, reconnectTimer

// ── Helpers ──────────────────────────────────────────────────────────
function $(id) {
    return document.getElementById(id)
}
function ts() {
    return new Date().toLocaleTimeString()
}

function pushRaw(dir, hex, injected) {
    rawMessages.push({ dir, hex, injected, time: ts() })
    if (rawMessages.length > 200) rawMessages.shift()
    const div = document.createElement('div')
    div.className = `msg ${dir}${injected ? ' injected' : ''}`
    div.innerHTML = `<span class="time">${ts()}</span><span class="dir">${dir === 'rx' ? '◀ DEV' : '▶ CLOUD'}</span>${hex}`
    $('raw_log').appendChild(div)
    $('raw_log').scrollTop = $('raw_log').scrollHeight
    $('raw_count').innerText = `(${rawMessages.length})`
}

// ── Packet parsing ───────────────────────────────────────────────────
function parseMicrowaveState(hex) {
    const b = hexToBytes(hex)
    if (b.length < 8) return {}
    // AA62 status packet: byte 7 = fan ('0' or '1' in ASCII)
    if (b[0] === 0xaa && b[1] === 0x62) {
        const fan = b[7] === 0x31 // '1' = on
        // Light state: 53XX byte in second block (around byte 47 or 96)
        // Look for 5310 pattern (light on) in the packet
        const hexStr = hex
        const lightOn = hexStr.includes('5310') && !hexStr.includes('5310008080808001')
        // More reliable: second 53xx block after the second FF030D
        const ffIdx = hexStr.lastIndexOf('ff030d')
        let light = false
        if (ffIdx > 0) {
            const afterFF = hexStr.substring(ffIdx + 6)
            const c3Idx = afterFF.indexOf('c3')
            if (c3Idx > 0) {
                const block = afterFF.substring(c3Idx)
                const match = block.match(/53([0-9a-f]{2})/)
                if (match) light = parseInt(match[1], 16) === 0x10
            }
        }
        return { fan, light }
    }
    // AA08 ACK: 410044 vs 410043
    if (b[0] === 0xaa && b[1] === 0x08 && b.length >= 6) {
        // 43 = accept/cancel'd, 44 = cancel — don't change state from these
    }
    return {}
}

function hexToBytes(hex) {
    const bytes = []
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16))
    return new Uint8Array(bytes)
}

// ── UI updates ───────────────────────────────────────────────────────
function updateDeviceHeader() {
    const name = FRIENDLY[deviceState.model] || deviceState.model || 'Unknown'
    $('dev_name').innerText = name
    $('dev_model').innerText = deviceState.model || '...'
    $('dev_type').innerText = deviceState.deviceType || '...'

    const dot = $('nav_status')
    if (deviceState.status === 'online') {
        dot.innerHTML = '<span class="status-dot online"></span> Connected'
        $('dev_name').style.color = '#fff'
    } else if (deviceState.status === 'connecting') {
        dot.innerHTML = '<span class="status-dot connecting"></span> Connecting...'
    } else {
        dot.innerHTML = '<span class="status-dot offline"></span> Offline'
        $('dev_name').style.color = '#8899aa'
    }

    if (deviceState.rssi !== null) {
        $('dev_rssi').innerText = `RSSI: ${deviceState.rssi} dBm`
    }
    if (deviceState.lastSeen) {
        const ago = Math.round((Date.now() - deviceState.lastSeen) / 1000)
        $('dev_uptime').innerText = `Last seen: ${ago}s ago`
    }
}

function updateStatusCards() {
    const cards = $('status_cards')
    const config = DEVICE_CONTROLS[deviceState.model]

    if (config) {
        cards.innerHTML = `
            <div class="state-card">
                <div class="icon">🌀</div>
                <div class="label">Vent Fan</div>
                <div class="value">${deviceState.fan ? 'ON' : 'OFF'}</div>
                <span class="badge ${deviceState.fan ? 'active' : 'inactive'}">${deviceState.fan ? 'Running' : 'Stopped'}</span>
            </div>
            <div class="state-card">
                <div class="icon">💡</div>
                <div class="label">Light</div>
                <div class="value">${deviceState.light ? 'ON' : 'OFF'}</div>
                <span class="badge ${deviceState.light ? 'active' : 'inactive'}">${deviceState.light ? 'Illuminated' : 'Dark'}</span>
            </div>
        `
    } else {
        // Generic: show last packet info
        cards.innerHTML = `
            <div class="state-card">
                <div class="icon">📡</div>
                <div class="label">Device Type</div>
                <div class="value">${deviceState.deviceType || '?'}</div>
                <div class="sub">${deviceState.model || 'Unknown'}</div>
            </div>
            <div class="state-card">
                <div class="icon">📊</div>
                <div class="label">Raw Packets</div>
                <div class="value">${rawMessages.length}</div>
                <div class="sub">Streaming to HA diagnostic sensor</div>
            </div>
        `
    }
}

function updateControls() {
    const panel = $('controls_panel')
    const config = DEVICE_CONTROLS[deviceState.model]

    if (!config) {
        panel.innerHTML = ''
        return
    }

    const online = deviceState.status === 'online'
    let html = '<div class="controls-section"><h3>Controls</h3>'

    for (const ctrl of config.controls) {
        const state = deviceState[ctrl.id]
        html += `
            <div class="control-row">
                <div class="ctrl-label">
                    <span class="material-icons">${ctrl.icon}</span>
                    <span class="ctrl-name">${ctrl.label}</span>
                </div>
                <button class="toggle-btn ${state ? 'on' : 'off'}"
                        id="ctrl_${ctrl.id}"
                        ${!online ? 'disabled' : ''}
                        onclick="toggleControl('${ctrl.id}')">
                    ${state ? 'ON' : 'OFF'}
                </button>
            </div>`
    }
    html += '</div>'
    panel.innerHTML = html
}

function toggleRaw() {
    $('raw_section').classList.toggle('collapsed')
}

async function toggleControl(ctrlId) {
    const config = DEVICE_CONTROLS[deviceState.model]
    if (!config) return

    const current = deviceState[ctrlId]
    const cmdKey = current ? `${ctrlId}_off` : `${ctrlId}_on`
    const hex = config.cmds[cmdKey]
    if (!hex) return

    // Send via WebSocket to be injected to the device
    if (ws && ws.readyState === WebSocket.OPEN) {
        // Use the sendToDevice mechanism
        ws.send(JSON.stringify({ sendToDevice: hex }))

        // Optimistic update
        deviceState[ctrlId] = !current
        updateStatusCards()
        updateControls()
    }
}

function processRx(hex) {
    // Track RSSI from device_packet metadata is not in raw hex, but we'll get it from state
    const config = DEVICE_CONTROLS[deviceState.model]
    if (config && config.stateParser) {
        const updates = config.stateParser(hex)
        let changed = false
        for (const key in updates) {
            if (deviceState[key] !== updates[key]) {
                deviceState[key] = updates[key]
                changed = true
            }
        }
        if (changed) {
            updateStatusCards()
            updateControls()
        }
    }
    deviceState.lastSeen = Date.now()
}

// ── WebSocket ────────────────────────────────────────────────────────
function connect() {
    clearTimeout(reconnectTimer)
    ws = new WebSocket(baseUrl + `device?id=${DEVICE_ID}`)

    ws.onclose = () => {
        deviceState.status = 'offline'
        updateDeviceHeader()
        updateControls()
        reconnectTimer = setTimeout(connect, 5000)
    }

    ws.onopen = () => {
        deviceState.status = 'connecting'
        updateDeviceHeader()
    }

    ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return
        const json = JSON.parse(ev.data)

        if (json.status) {
            deviceState.status = json.status
            updateDeviceHeader()
            updateControls()
        }

        if (json.meta) {
            deviceState.model = json.meta.modelId || ''
            deviceState.deviceType = json.meta.deviceType || ''
            deviceState.meta = json.meta
            updateDeviceHeader()
            updateStatusCards()
            updateControls()
        }

        if (json.rx) {
            pushRaw('rx', json.rx, json.injected)
            processRx(json.rx)
            if (json.rssi != null) deviceState.rssi = json.rssi
        }

        if (json.tx) {
            pushRaw('tx', json.tx, json.injected)
        }
    }
}

// ── Init ─────────────────────────────────────────────────────────────
$('dev_name').innerText = 'Loading...'
connect()
