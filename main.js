/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core'); // Get common adapter utils
let adapter;

const objectHelper = require('@apollon/iobroker-tools').objectHelper; // Get common adapter utils
const MerossCloud = require('meross-cloud');
let meross;
let tokenData = null;

const knownDevices = {};
let connected = null;
let stopped = false;

const roleValues = {
    'power': {scale: -3, unit: 'W', role: 'value.power'},
    'current': {scale: -3, unit: 'A', role: 'value.current'},
    'voltage': {scale: -1, unit: 'V', role: 'value.voltage'},
    'rgb': {unit: '', role: 'level.color.rgb'},
    'temperature': {unit: 'K', role: 'level.color.temperature', min: 1, max: 100},
    'luminance': {unit: '', role: 'level.color.luminance', min: 1, max: 100},
    'gradual': {unit: ''},
    'transform': {unit: ''},
    'currentTemp': {scale: -1, role: 'value.temperature', min: 5, max: 35},
    'heatTemp': {scale: -1, role: 'level'},
    'coolTemp': {scale: -1, role: 'level'},
    'ecoTemp': {scale: -1, role: 'level'},
    'manualTemp': {scale: -1, role: 'level'},
    'targetTemp': {scale: -1, role: 'level.temperature'}
};

let Sentry;
let SentryIntegrations;
function initSentry(callback) {
    if (!adapter.ioPack.common || !adapter.ioPack.common.plugins || !adapter.ioPack.common.plugins.sentry) {
        return callback && callback();
    }
    const sentryConfig = adapter.ioPack.common.plugins.sentry;
    if (!sentryConfig.dsn) {
        adapter.log.warn('Invalid Sentry definition, no dsn provided. Disable error reporting');
        return callback && callback();
    }
    // Require needed tooling
    Sentry = require('@sentry/node');
    SentryIntegrations = require('@sentry/integrations');
    // By installing source map support, we get the original source
    // locations in error messages
    require('source-map-support').install();

    let sentryPathWhitelist = [];
    if (sentryConfig.pathWhitelist && Array.isArray(sentryConfig.pathWhitelist)) {
        sentryPathWhitelist = sentryConfig.pathWhitelist;
    }
    if (adapter.pack.name && !sentryPathWhitelist.includes(adapter.pack.name)) {
        sentryPathWhitelist.push(adapter.pack.name);
    }
    let sentryErrorBlacklist = [];
    if (sentryConfig.errorBlacklist && Array.isArray(sentryConfig.errorBlacklist)) {
        sentryErrorBlacklist = sentryConfig.errorBlacklist;
    }
    if (!sentryErrorBlacklist.includes('SyntaxError')) {
        sentryErrorBlacklist.push('SyntaxError');
    }

    Sentry.init({
        release: `${adapter.pack.name}@${adapter.pack.version}`,
        dsn: sentryConfig.dsn,
        integrations: [
            new SentryIntegrations.Dedupe()
        ]
    });
    Sentry.configureScope(scope => {
        scope.setTag('version', adapter.common.installedVersion || adapter.common.version);
        if (adapter.common.installedFrom) {
            scope.setTag('installedFrom', adapter.common.installedFrom);
        }
        else {
            scope.setTag('installedFrom', adapter.common.installedVersion || adapter.common.version);
        }
        scope.addEventProcessor(function(event, hint) {
            // Try to filter out some events
            if (event.exception && event.exception.values && event.exception.values[0]) {
                const eventData = event.exception.values[0];
                // if error type is one from blacklist we ignore this error
                if (eventData.type && sentryErrorBlacklist.includes(eventData.type)) {
                    return null;
                }
                if (eventData.stacktrace && eventData.stacktrace.frames && Array.isArray(eventData.stacktrace.frames) && eventData.stacktrace.frames.length) {
                    // if last exception frame is from an nodejs internal method we ignore this error
                    if (eventData.stacktrace.frames[eventData.stacktrace.frames.length - 1].filename && (eventData.stacktrace.frames[eventData.stacktrace.frames.length - 1].filename.startsWith('internal/') || eventData.stacktrace.frames[eventData.stacktrace.frames.length - 1].filename.startsWith('Module.'))) {
                        return null;
                    }
                    // Check if any entry is whitelisted from pathWhitelist
                    const whitelisted = eventData.stacktrace.frames.find(frame => {
                        if (frame.function && frame.function.startsWith('Module.')) {
                            return false;
                        }
                        if (frame.filename && frame.filename.startsWith('internal/')) {
                            return false;
                        }
                        if (frame.filename && !sentryPathWhitelist.find(path => path && path.length && frame.filename.includes(path))) {
                            return false;
                        }
                        return true;
                    });
                    if (!whitelisted) {
                        return null;
                    }
                }
            }

            return event;
        });

        adapter.getForeignObject('system.config', (err, obj) => {
            if (obj && obj.common && obj.common.diag !== 'none') {
                adapter.getForeignObject('system.meta.uuid', (err, obj) => {
                    // create uuid
                    if (!err  && obj) {
                        Sentry.configureScope(scope => {
                            scope.setUser({
                                id: obj.native.uuid
                            });
                        });
                    }
                    callback && callback();
                });
            }
            else {
                callback && callback();
            }
        });
    });
}

function decrypt(key, value) {
    let result = '';
    for (let i = 0; i < value.length; ++i) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

function setConnected(isConnected) {
    if (connected !== isConnected) {
        connected = isConnected;
        adapter && adapter.setState && adapter.setState('info.connection', connected, true, (err) => {
            // analyse if the state could be set (because of permissions)
            if (err && adapter && adapter.log) adapter.log.error(`Can not update connected state: ${err}`);
                else if (adapter && adapter.log) adapter.log.debug(`connected set to ${connected}`);
        });
    }
}

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'meross'
    });
    adapter = new utils.Adapter(options);

    // is called when adapter shuts down - callback has to be called under any circumstances!
    adapter.on('unload', function(callback) {
        stopped = true;
        try {
            setConnected(false);
            stopAll();
        } catch (e) {
            callback();
        }
    });

    // is called if a subscribed state changes
    adapter.on('stateChange', function(id, state) {
        // Warning, state can be null if it was deleted
        adapter.log.debug(`stateChange ${id} ${JSON.stringify(state)}`);
        objectHelper.handleStateChange(id, state);
    });

    adapter.on('ready', () => {
        function prepareMain() {
            adapter.getForeignObject('system.config', (err, obj) => {
                if (!adapter.supportsFeature || !adapter.supportsFeature('ADAPTER_AUTO_DECRYPT_NATIVE')) {
                    if (obj && obj.native && obj.native.secret) {
                        //noinspection JSUnresolvedVariable
                        adapter.config.password = decrypt(obj.native.secret, adapter.config.password);
                    } else {
                        //noinspection JSUnresolvedVariable
                        adapter.config.password = decrypt('Zgfr56gFe87jJOM', adapter.config.password);
                    }
                }
                adapter.getObject('_config', (err, obj) => {
                    if (err) {
                        adapter.setObject('_config', {
                            type: 'config',
                            common: {
                                name: 'Login Token data for Meross',
                                'expert': true
                            },
                            native: {}
                        }, () => main());
                    } else {
                        if (obj.native && obj.native.tokenData && obj.native.tokenData.token) {
                            tokenData = obj.native.tokenData;
                        }
                        main();
                    }
                })
            });
        }

        if (adapter.supportsFeature && adapter.supportsFeature('PLUGINS')) {
            prepareMain();
        }
        else {
            initSentry(prepareMain);
        }
    });

    return adapter;
}

function stopAll() {
    stopped = true;
    if (meross) {
        meross.disconnectAll(true);
    }
}

function defineRole(obj) {
    // Try to set roles
    let role = '';
    if (obj.type === 'boolean') {
        if (obj.read && !obj.write) { // Boolean, read-only --> Sensor OR Indicator!
            role = 'sensor';
        }
        else if (obj.write && !obj.read) { // Boolean, write-only --> Button
            role = 'button';
        }
        else if (obj.read && obj.write) { // Boolean, read-write --> Switch
            role = 'switch';
        }
    }
    else if (obj.type === 'number') {
        if (obj.read && !obj.write) { // Number, read-only --> Value
            role = 'value';
        }
        else if (obj.write && !obj.read) { // Boolean, write-only --> ?? Level?
            role = 'level';
        }
        else if (obj.read && obj.write) { // Number, read-write --> Level
            role = 'level';
        }
    }
    else if (obj.type === 'string') {
        role = 'text';
    }
    return role;
}

function convertNumberToHex(number) {
    if (typeof number === 'string' && number[0] === '#') {
        return number;
    }
    return `#${(`000000${((number) >>> 0).toString(16)}`).slice(-6)}`;
}
function convertHexToNumber(hex) {
    if (typeof hex !== 'string') {
        hex = hex.toString();
    }
    if (hex && hex[0]=== '#') {
        hex = hex.substring(1);
    }
    return parseInt(hex, 16);
}

function initDeviceObjects(deviceId, channels, data) {
    const objs = [];
    const values = {};

    adapter.log.debug(`${deviceId}: initDeviceObjects with channels = ${JSON.stringify(channels)} and data = ${JSON.stringify(data)}`);
    if (data && data.toggle) {
        const val = data.toggle;
        const common = {};
        if (val.onoff !== undefined) {
            common.type = 'boolean';
            common.read = true;
            common.write = true;
            common.name = 'Switch';
            common.role = defineRole(common);
            common.id = '0-switch';
            values['0-switch'] = !!val.onoff;

            common.onChange = (value) => {
                if (!knownDevices[deviceId].device) {
                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                    return;
                }

                knownDevices[deviceId].device.controlToggle((value ? 1 : 0), (err, res) => {
                    adapter.log.debug(`Toggle Response: err: ${err}, res: ${JSON.stringify(res)}`);
                    adapter.log.debug(`${deviceId}.0: set value ${value}`);

                    if (knownDevices[deviceId].deviceAbilities.ability['Appliance.Control.Electricity']) {
                        pollElectricity(deviceId, 2);
                    }
                });
            };
            objs.push(common);
        }
        else {
            adapter.log.info(`Unsupported type for digest val ${JSON.stringify(val)}`);
            return;
        }
    }
    else if (data && data.togglex && !data.garageDoor && !data.diffuser) {
        if (!Array.isArray(data.togglex)) {
            data.togglex = [data.togglex];
        }
        data.togglex.forEach((val) => {
            const common = {};
            if (val.onoff !== undefined) {
                common.type = 'boolean';
                common.read = true;
                common.write = true;
                common.name = '';
                if (channels[val.channel] && channels[val.channel].devName) {
                    common.name = channels[val.channel].devName;
                }
                if (!common.name.length && val.channel === 0) {
                    common.name = 'All';
                }
                common.role = defineRole(common);
                common.id = val.channel;
                values[val.channel] = !!val.onoff;

                common.onChange = (value) => {
                    if (!knownDevices[deviceId].device) {
                        adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                        return;
                    }

                    knownDevices[deviceId].device.controlToggleX(val.channel, (value ? 1 : 0), (err, res) => {
                        adapter.log.debug(`ToggleX Response: err: ${err}, res: ${JSON.stringify(res)}`);
                        adapter.log.debug(`${deviceId}.${val.channel}: set value ${value}`);

                        if (knownDevices[deviceId].deviceAbilities && knownDevices[deviceId].deviceAbilities.ability['Appliance.Control.Electricity']) {
                            pollElectricity(deviceId, 2);
                        }
                    });
                };
                objs.push(common);
            }
            else {
                adapter.log.info(`Unsupported type for digest togglex val ${JSON.stringify(val)}`);
            }
        });
    }

    if (data && data.electricity) {
        if (data.electricity.channel === undefined || data.electricity.channel !==0) {
            adapter.log.info(`Unsupported type for electricity val ${JSON.stringify(data)}`);
            return;
        }
        const channel = data.electricity.channel;
        for (let key in data.electricity) {
            if (!data.electricity.hasOwnProperty(key)) continue;
            if (key === 'channel') continue;
            const common = {};
            common.type = 'number';
            common.read = true;
            common.write = false;
            common.name = key;
            common.role = (roleValues[key] && roleValues[key].role) ? roleValues[key].role : defineRole(common);
            common.id = `${channel}-${key}`;
            values[common.id] = Math.floor(data.electricity[key] * Math.pow(10, (roleValues[key] ? roleValues[key].scale || 0 : 0)) * 100) / 100;
            if (roleValues[key] && roleValues[key].unit) common.unit = roleValues[key].unit;

            objs.push(common);
        }
    }

    if (data && data.garageDoor) {
        if (!Array.isArray(data.garageDoor)) {
            adapter.log.info(`Unsupported type for garageDoor val ${JSON.stringify(data)}`);
            return;
        }
        data.garageDoor.forEach((val) => {
            if (val.open !== undefined) {
                const common = {};
                common.type = 'boolean';
                common.read = true;
                common.write = true;
                common.name = `${val.channel}-garageDoor`;
                common.role = defineRole(common);
                common.id = common.name;
                values[common.name] = !!val.open;

                common.onChange = (value) => {
                    if (!knownDevices[deviceId].device) {
                        adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                        return;
                    }

                    knownDevices[deviceId].device.controlGarageDoor(val.channel, (value ? 1 : 0), (err, res) => {
                        adapter.log.debug(`GarageDoor Response: err: ${err}, res: ${JSON.stringify(res)}`);
                        adapter.log.debug(`${deviceId}.${val.channel}-garageDoor: set value ${value}`);
                        if (res && res.state) {
                            adapter.setState(`${deviceId}.${val.channel}-garageDoorWorking`, !!res.state.execute, true);
                        }
                    });
                };
                objs.push(common);

                const common2 = {};
                common2.type = 'boolean';
                common2.read = true;
                common2.write = false;
                common2.name = `${val.channel}-garageDoorWorking`;
                common2.role = defineRole(common2);
                common2.id = common2.name;
                values[common2.name] = false;

                objs.push(common2);
            }
            else {
                adapter.log.info(`Unsupported type for digest val ${JSON.stringify(val)}`);
            }
        });
    }

    if (data && data.spray) {
        if (!Array.isArray(data.spray)) {
            data.spray = [data.spray];
        }
        data.spray.forEach((val) => {
            const common = {};
            if (val.mode !== undefined) {
                common.type = 'number';
                common.read = true;
                common.write = true;
                common.name = `${val.channel}-mode`;
                common.role = defineRole(common);
                common.states = {0: 'Off', 1: 'Continuous', 2: 'Intermittent'};
                common.id = common.name;
                values[`${val.channel}-mode`] = val.mode;

                common.onChange = (value) => {
                    if (!knownDevices[deviceId].device) {
                        adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                        return;
                    }

                    knownDevices[deviceId].device.controlSpray(val.channel, value, (err, res) => {
                        adapter.log.debug(`Spray Response: err: ${err}, res: ${JSON.stringify(res)}`);
                        adapter.log.debug(`${deviceId}.${val.channel}: set spray value ${value}`);
                    });
                };
                objs.push(common);
            }
            else {
                adapter.log.info(`Unsupported type for spray digest val ${JSON.stringify(val)}`);
            }
        });
    }

    if (data && data.light) {
        for (let key in data.light) {
            if (!data.light.hasOwnProperty(key)) continue;
            if (key === 'channel' || key === 'capacity') continue;
            const common = {};
            common.type = (key === 'rgb') ? 'string' : 'number';
            common.read = true;
            common.write = true;
            common.name = `${data.light.channel}-${key}`;
            common.role = (roleValues[key] && roleValues[key].role) ? roleValues[key].role : defineRole(common);
            common.id = common.name;
            values[common.id] = (key === 'rgb') ? convertNumberToHex(data.light[key]) : data.light[key];
            if (roleValues[key] && roleValues[key].unit) common.unit = roleValues[key].unit;

            common.onChange = (value) => {
                if (!knownDevices[deviceId].device) {
                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                    return;
                }

                const controlData = {
                    channel: data.light.channel,
                    gradual: 0
                };
                controlData[key] = (key === 'rgb') ? convertHexToNumber(value) : value;
                switch (key) {
                    /*
                        MODE_LUMINANCE = 4
                        MODE_TEMPERATURE = 2
                        MODE_RGB = 1
                        MODE_RGB_LUMINANCE = 5
                        MODE_TEMPERATURE_LUMINANCE = 6
                    */
                    case 'rgb':
                        controlData.capacity = 1;
                        break;
                    case 'temperature':
                        controlData.capacity = 2;
                        break;
                    case 'luminance':
                        controlData.capacity = 4;
                        break;
                }
                knownDevices[deviceId].device.controlLight(controlData, (err, res) => {
                    adapter.log.debug(`Light Response: err: ${err}, res: ${JSON.stringify(res)}`);
                    adapter.log.debug(`${deviceId}.${data.light.channel}-${key}: set light value ${JSON.stringify(controlData)}`);
                });
            };
            objs.push(common);
        }
    }

    if (data && data.thermostat) {
        if (data.thermostat.mode) {
            data.thermostat.mode.forEach(val => {
                const channel = val.channel;
                for (let key in val) {
                    if (!val.hasOwnProperty(key)) continue;
                    if (key === 'channel' || key === 'min' || key === 'max') continue;
                    const common = {};
                    common.type = 'number';
                    common.read = true;
                    if (key.endsWith('Temp')) {
                        if (key === 'currentTemp') {
                            common.write = false;
                        } else {
                            common.write = true;
                            common.min = Math.floor(val.min * Math.pow(10, -1) * 100) / 100;
                            common.max = Math.floor(val.max * Math.pow(10, -1) * 100) / 100;
                        }
                        if (roleValues[key] && roleValues[key].scale !== undefined) {
                            val[key] = Math.floor(val[key] * Math.pow(10, roleValues[key].scale) * 100) / 100;
                        }
                    } else if (key === 'onoff') {
                        common.write = true;
                        common.type = 'boolean';
                    } else if (key === 'state') {
                        common.write = false;
                        common.type = 'boolean';
                    } else if (key === 'warning') {
                        common.write = false;
                        common.type = 'boolean';
                    } else if (key === 'mode') {
                        common.write = true;
                        common.states = {0: 'HEATING', 1: 'COOLING', 2: 'ECO', 3: 'AUTO', 4: 'MANU'};
                    }

                    if (common.write) {
                        common.onChange = async (value) => {
                            if (!knownDevices[deviceId].device) {
                                adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                return;
                            }

                            const controlData = {};
                            if (common.type === 'boolean') {
                                controlData[key] = value ? 1 : 0;
                            } else {
                                if (roleValues[key] && roleValues[key].scale !== undefined) {
                                    value = value * Math.pow(10, -roleValues[key].scale);
                                }
                                controlData[key] = value;
                                switch (key) {
                                    case 'targetTemp':
                                        controlData.manualTemp = value;
                                        delete controlData[key];
                                        controlData.mode = 4;
                                        break;
                                    case 'mode':
                                        switch (value) {
                                            case 0: // HEATING
                                                const heatTemp = await adapter.getStateAsync(`${channel}-mode-heatTemp`);
                                                if (heatTemp && heatTemp.val) {
                                                    controlData.targetTemp = heatTemp.val * Math.pow(10, -roleValues.targetTemp.scale)
                                                }
                                                break;
                                            case 1: // COOLING
                                                const coolTemp = await adapter.getStateAsync(`${channel}-mode-coolTemp`);
                                                if (coolTemp && coolTemp.val) {
                                                    controlData.targetTemp = coolTemp.val * Math.pow(10, -roleValues.targetTemp.scale)
                                                }
                                                break;
                                            case 2: // ECO
                                                const ecoTemp = await adapter.getStateAsync(`${channel}-mode-ecoTemp`);
                                                if (ecoTemp && ecoTemp.val) {
                                                    controlData.targetTemp = ecoTemp.val * Math.pow(10, -roleValues.targetTemp.scale)
                                                }
                                                break;
                                            case 4: // MANUAL
                                                const manualTemp = await adapter.getStateAsync(`${channel}-mode-manualTemp`);
                                                if (manualTemp && manualTemp.val) {
                                                    controlData.targetTemp = manualTemp.val * Math.pow(10, -roleValues.targetTemp.scale)
                                                }
                                                break;
                                        }
                                        break;
                                }
                            }

                            knownDevices[deviceId].device.controlThermostatMode(channel, controlData, (err, res) => {
                                adapter.log.debug(`Thermostat Mode Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                adapter.log.debug(`${deviceId}.${channel}-${key}: set value ${JSON.stringify(controlData)}`);
                            });
                        };
                    }

                    common.name = key;
                    common.role = (roleValues[key] && roleValues[key].role) ? roleValues[key].role : defineRole(common);
                    common.id = `${channel}-mode-${key}`;

                    values[common.id] = common.type === 'boolean' ? !!val[key] : val[key];
                    if (roleValues[key] && roleValues[key].unit) common.unit = roleValues[key].unit;

                    objs.push(common);
                }
            });
        }
        if (data.thermostat.windowOpened) {
            data.thermostat.windowOpened.forEach(val => {
                const channel = val.channel;
                for (let key in val) {
                    if (!val.hasOwnProperty(key)) continue;
                    if (key === 'channel') continue;
                    const common = {};
                    common.type = key === 'status' ? 'boolean' : 'number';
                    common.read = true;
                    common.write = false;
                    common.name = key;
                    common.role = (roleValues[key] && roleValues[key].role) ? roleValues[key].role : defineRole(common);
                    common.id = `${channel}-windowOpened-${key}`;
                    values[common.id] = key === 'status' ? !!val[key] : val[key];
                    if (roleValues[key] && roleValues[key].unit) common.unit = roleValues[key].unit;

                    objs.push(common);
                }
            });
        }
    }


    if (data && data.DNDMode) {
        const common = {};
        common.type = 'boolean';
        common.read = true;
        common.write = true;
        common.name = 'dnd';
        common.role = defineRole(common);
        common.id = common.name;
        values[common.id] = !!data.DNDMode.mode;

        common.onChange = (value) => {
            if (!knownDevices[deviceId].device) {
                adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                return;
            }

            knownDevices[deviceId].device.setSystemDNDMode(!!value, (err, res) => {
                adapter.log.debug(`DNDMode Response: err: ${err}, res: ${JSON.stringify(res)}`);
                adapter.log.debug(`${deviceId}: set DNDMode value ${value}`);

                knownDevices[deviceId].device.getSystemDNDMode((err, res) => {
                    adapter.log.debug(`DNDMode Response: err: ${err}, res: ${JSON.stringify(res)}`);
                    adapter.log.debug(`${deviceId}: get DNDMode value ${value}`);
                    if (res && res.DNDMode) {
                        adapter.setState(`${deviceId}.dnd`, !!res.DNDMode.mode, true);
                    }
                });
            });
        };

        objs.push(common);
    }

    if (data && data.hub) {
        let common = {};
        common.type = 'number';
        common.read = true;
        common.write = false;
        common.name = 'mode';
        common.role = defineRole(common);
        common.id = common.name;
        values[common.id] = data.hub.mode;

        objs.push(common);

        const subDeviceInfo = {};
        if (knownDevices[deviceId].device.subDeviceList) {
            knownDevices[deviceId].device.subDeviceList.forEach(sub => {
                subDeviceInfo[sub.subDeviceId] = sub;
            });
        }

        data.hub.subdevice.forEach(sub => {
            let name = 'Hub Device';
            if (subDeviceInfo[sub.id] && subDeviceInfo[sub.id].subDeviceName) {
                name = subDeviceInfo[sub.id].subDeviceName;
            }
            if (sub.mts100) {
                name += ' MTS100';
            } else if (sub.mts150) {
                name += ' MTS150';
            } else if (sub.mts100v3) {
                name += ' MTS100v3';
            } else if (sub.ms100) {
                name += ' MS100';
            } else if (sub.smokeAlarm) {
                name += ' SmokeAlarm';
            } else if (sub.doorWindow) {
                name += ' Door/Window';
            }
            objectHelper.setOrUpdateObject(`${deviceId}.${sub.id}`, {
                type: 'channel',
                common: {
                    name: name,
                    statusStates: {
                        onlineId: `${adapter.namespace}.${deviceId}.${sub.id}.online`
                    }
                },
                native: sub
            });


            let common = {};
            common.type = 'boolean';
            common.read = true;
            common.write = false;
            common.name = 'online';
            common.role = 'indicator.reachable';
            common.id = `${sub.id}.${common.name}`;
            values[common.id] = parseInt(sub.status) === 1;

            objs.push(common);

            if (sub.onoff !== undefined) {
                common = {};
                common.type = 'boolean';
                common.read = true;
                common.write = true;
                common.name = 'switch';
                common.role = defineRole(common);
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = !!sub.onoff;

                common.onChange = (value) => {
                    if (!knownDevices[deviceId].device) {
                        adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                        return;
                    }

                    knownDevices[deviceId].device.controlHubToggleX(sub.id, (value ? 1 : 0), (err, res) => {
                        adapter.log.debug(`Hub-ToggleX Response: err: ${err}, res: ${JSON.stringify(res)}`);
                        adapter.log.debug(`${deviceId}.${sub.id}.switch: set value ${value}`);

                        knownDevices[deviceId].device.getMts100All([sub.id], (err, res) => {
                            if (res && res.all && res.all[0] && res.all[0].togglex) {
                                res.all[0].togglex.id = sub.id;
                                setValuesHubToggleX(deviceId, res.all[0]);
                            }
                        });
                    });
                };
                objs.push(common);
            }

            if (sub.mts100 || sub.mts100v3 || sub.mts150) {
                common = {};
                common.type = 'number';
                common.read = true;
                common.write = true;
                common.name = 'mode';
                common.role = defineRole(common);
                common.id = `${sub.id}.${common.name}`;
                if (sub.mts100) {
                    values[common.id] = sub.mts100.mode;
                } else if (sub.mts100v3) {
                    values[common.id] = sub.mts100v3.mode;
                } else if (sub.mts150) {
                    values[common.id] = sub.mts150.mode;
                }
                common.min = 0;
                common.max = 4;
                common.states = {0: 'MODE_0', 1: 'MODE_1', 2: 'MODE_2', 3: 'MODE_3', 4: 'MODE_4'};
                // Schedule mode 'klötze' 3
                // Comfort Mode 1
                // Economy Mode 2
                // Manual ?? 0

                common.onChange = (value) => {
                    if (!knownDevices[deviceId].device) {
                        adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                        return;
                    }

                    knownDevices[deviceId].device.controlHubMts100Mode(sub.id, value, (err, res) => {
                        adapter.log.debug(`Hub-Mode Response: err: ${err}, res: ${JSON.stringify(res)}`);
                        adapter.log.debug(`${deviceId}.${sub.id}.mode: set value ${value}`);

                        knownDevices[deviceId].device.getMts100All([sub.id], (err, res) => {
                            if (res && res.all && res.all[0] && res.all[0].mode) {
                                res.all[0].mode.id = sub.id;
                                setValuesHubMts100Mode(deviceId, res.all[0]);
                            }
                        });
                    });
                };

                objs.push(common);

                if (knownDevices[deviceId].deviceAbilities && knownDevices[deviceId].deviceAbilities.ability['Appliance.Hub.Mts100.Temperature']) {
                    common = {};
                    common.type = 'number';
                    common.read = true;
                    common.write = true;
                    common.name = 'custom';
                    common.role = defineRole(common);
                    common.id = `${sub.id}.${common.name}`;
                    common.unit = '°C';
                    common.min = 5;
                    common.max = 35;

                    common.onChange = (value) => {
                        if (!knownDevices[deviceId].device) {
                            adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                            return;
                        }

                        knownDevices[deviceId].device.controlHubMts100Temperature(sub.id, {custom: value * 10}, (err, res) => {
                            adapter.log.debug(`Hub-Temperature Response: err: ${err}, res: ${JSON.stringify(res)}`);
                            adapter.log.debug(`${deviceId}.${sub.id}.custom: set value ${value}`);
                            setValuesHubMts100Temperature(deviceId, res);
                        });
                    };

                    objs.push(common);

                    common = {};
                    common.type = 'number';
                    common.read = true;
                    common.write = true;
                    common.name = 'currentSet';
                    common.role = defineRole(common);
                    common.id = `${sub.id}.${common.name}`;
                    common.unit = '°C';
                    common.min = 5;
                    common.max = 35;

                    common.onChange = (value) => {
                        if (!knownDevices[deviceId].device) {
                            adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                            return;
                        }

                        knownDevices[deviceId].device.controlHubMts100Temperature(sub.id, {currentSet: value * 10}, (err, res) => {
                            adapter.log.debug(`Hub-Temperature Response: err: ${err}, res: ${JSON.stringify(res)}`);
                            adapter.log.debug(`${deviceId}.${sub.id}.currentSet: set value ${value}`);
                            setValuesHubMts100Temperature(deviceId, res);
                        });
                    };

                    objs.push(common);

                    common = {};
                    common.type = 'number';
                    common.read = true;
                    common.write = true;
                    common.name = 'comfort';
                    common.role = defineRole(common);
                    common.id = `${sub.id}.${common.name}`;
                    common.unit = '°C';
                    common.min = 5;
                    common.max = 35;

                    common.onChange = (value) => {
                        if (!knownDevices[deviceId].device) {
                            adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                            return;
                        }

                        knownDevices[deviceId].device.controlHubMts100Temperature(sub.id, {comfort: value * 10}, (err, res) => {
                            adapter.log.debug(`Hub-Temperature Response: err: ${err}, res: ${JSON.stringify(res)}`);
                            adapter.log.debug(`${deviceId}.${sub.id}.comfort: set value ${value}`);
                            setValuesHubMts100Temperature(deviceId, res);
                        });
                    };

                    objs.push(common);

                    common = {};
                    common.type = 'number';
                    common.read = true;
                    common.write = true;
                    common.name = 'economy';
                    common.role = defineRole(common);
                    common.id = `${sub.id}.${common.name}`;
                    common.unit = '°C';
                    common.min = 5;
                    common.max = 35;

                    common.onChange = (value) => {
                        if (!knownDevices[deviceId].device) {
                            adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                            return;
                        }

                        knownDevices[deviceId].device.controlHubMts100Temperature(sub.id, {economy: value * 10}, (err, res) => {
                            adapter.log.debug(`Hub-Temperature Response: err: ${err}, res: ${JSON.stringify(res)}`);
                            adapter.log.debug(`${deviceId}.${sub.id}.economy: set value ${value}`);
                            setValuesHubMts100Temperature(deviceId, res);
                        });
                    };

                    objs.push(common);

                    if (sub.mts100v3 || sub.mts150) {
                        common = {};
                        common.type = 'number';
                        common.read = true;
                        common.write = true;
                        common.name = 'away';
                        common.role = defineRole(common);
                        common.id = `${sub.id}.${common.name}`;
                        common.unit = '°C';
                        common.min = 5;
                        common.max = 35;

                        common.onChange = (value) => {
                            if (!knownDevices[deviceId].device) {
                                adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                return;
                            }

                            knownDevices[deviceId].device.controlHubMts100Temperature(sub.id, {away: value * 10}, (err, res) => {
                                adapter.log.debug(`Hub-Temperature Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                adapter.log.debug(`${deviceId}.${sub.id}.economy: set value ${value}`);
                                setValuesHubMts100Temperature(deviceId, res);
                            });
                        };

                        objs.push(common);
                    }

                    common = {};
                    common.type = 'number';
                    common.read = true;
                    common.write = false;
                    common.name = 'room';
                    common.role = defineRole(common);
                    common.id = `${sub.id}.${common.name}`;
                    common.unit = '°C';

                    objs.push(common);

                    common = {};
                    common.type = 'boolean';
                    common.read = true;
                    common.write = false;
                    common.name = 'heating';
                    common.role = defineRole(common);
                    common.id = `${sub.id}.${common.name}`;

                    objs.push(common);

                    common = {};
                    common.type = 'boolean';
                    common.read = true;
                    common.write = false;
                    common.name = 'openWindow';
                    common.role = defineRole(common);
                    common.id = `${sub.id}.${common.name}`;

                    objs.push(common);

                    knownDevices[deviceId].device.getMts100All([sub.id], (err, res) => {
                        if (res && res.all && res.all[0] && res.all[0].temperature) {
                            res.all[0].temperature.id = sub.id;
                            setValuesHubMts100Temperature(deviceId, res.all[0]);
                        }
                    });
                }
            } else if (sub.smokeAlarm) {
                common = {};
                common.type = 'number';
                common.read = true;
                common.write = false;
                common.name = 'status';
                common.states =  {170: 'OK', 23: 'TEST', 25: 'ALARM'}
                common.role = defineRole(common);
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = sub.smokeAlarm.status;
                objs.push(common);

                common = {};
                common.type = 'boolean';
                common.read = true;
                common.write = false;
                common.name = 'alarm';
                common.role = 'sensor.alarm.fire';
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = sub.smokeAlarm.status === 25;
                objs.push(common);

                common = {};
                common.type = 'boolean';
                common.read = true;
                common.write = false;
                common.name = 'interConn';
                common.role = 'indicator';
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = !!sub.smokeAlarm.interConn;
                objs.push(common);
            } else if (sub.doorWindow) {
                common = {};
                common.type = 'boolean';
                common.read = true;
                common.write = false;
                common.name = 'status';
                common.role = 'sensor.window';
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = !!sub.doorWindow.status; // 1=open, 0=closed
                objs.push(common);
            }

            if (knownDevices[deviceId].deviceAbilities && knownDevices[deviceId].deviceAbilities.ability['Appliance.Hub.Battery']) {
                common = {};
                common.type = 'number';
                common.read = true;
                common.write = false;
                common.name = 'battery';
                common.role = defineRole(common);
                common.id = `${sub.id}.${common.name}`;
                common.unit = '%';

                objs.push(common);

                knownDevices[deviceId].device.getHubBattery((err, res) => {
                    setValuesHubBattery(deviceId, res);
                });
            }

            if (knownDevices[deviceId].deviceAbilities && knownDevices[deviceId].deviceAbilities.ability['Appliance.Hub.Sensor.TempHum'] && sub.ms100) {
                common = {};
                common.type = 'number';
                common.read = true;
                common.write = false;
                common.name = 'latestTemperature';
                common.role = 'value.temperature';
                common.unit = '°C';
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = sub.ms100.latestTemperature / 10;

                objs.push(common);

                common = {};
                common.type = 'number';
                common.read = true;
                common.write = false;
                common.name = 'latestHumidity';
                common.role = 'value.humidity';
                common.unit = '%';
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = sub.ms100.latestHumidity / 10;

                objs.push(common);

                common = {};
                common.type = 'number';
                common.read = true;
                common.write = false;
                common.name = 'voltage';
                common.role = defineRole(common);
                common.unit = 'V';
                common.id = `${sub.id}.${common.name}`;
                values[common.id] = sub.ms100.voltage / 1000;

                objs.push(common);
            }
        });
    }

    if (data && data.diffuser) {
        if (data.diffuser.type && data.diffuser.type === 'mod100') {
            if (data.diffuser.spray) {
                if (!Array.isArray(data.diffuser.spray)) {
                    data.diffuser.spray = [data.diffuser.spray];
                }
                data.diffuser.spray.forEach((val) => {
                    const common = {};
                    if (val.mode !== undefined) {
                        common.type = 'number';
                        common.read = true;
                        common.write = true;
                        common.name = `${val.channel}-mode`;
                        common.role = defineRole(common);
                        common.states = {0: 'Light Spray', 1: 'Dense Spray', 2: 'Off'};
                        common.id = common.name;
                        values[`${val.channel}-mode`] = val.mode;

                        common.onChange = (value) => {
                            if (!knownDevices[deviceId].device) {
                                adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                return;
                            }

                            knownDevices[deviceId].device.controlDiffusorSpray(data.diffuser.type, val.channel, value, (err, res) => {
                                adapter.log.debug(`Diffusor-Spray Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                adapter.log.debug(`${deviceId}.${val.channel}: set spray value ${value}`);
                            });
                        };
                        objs.push(common);
                    }
                    else {
                        adapter.log.info(`Unsupported type for spray digest val ${JSON.stringify(val)}`);
                    }
                });
            }

            // { "channel": 0, "onoff": 1, "mode": 1, "luminance": 84, "rgb": 65413 }
            if (data.diffuser.light) {
                if (!Array.isArray(data.diffuser.light)) {
                    data.diffuser.light = [data.diffuser.light];
                }
                data.diffuser.light.forEach(diffuserLight => {
                    for (let key in diffuserLight) {
                        if (!diffuserLight.hasOwnProperty(key)) continue;
                        if (key === 'channel') continue;
                        const common = {};
                        common.type = (key === 'rgb') ? 'string' : ((key === 'onoff') ? 'boolean' : 'number');
                        common.read = true;
                        common.write = true;
                        common.name = `light-${diffuserLight.channel}-${key}`;
                        if (key === 'mode') {
                            common.states = {0: 'Auto cycle (RGB)', 1: 'RGB', 2: 'Color Temperature'};
                        }
                        common.role = (roleValues[key] && roleValues[key].role) ? roleValues[key].role : defineRole(common);
                        common.id = common.name;
                        values[common.id] = (key === 'rgb') ? convertNumberToHex(diffuserLight[key]) : ((key === 'onoff') ? !!diffuserLight[key] : diffuserLight[key]);
                        if (roleValues[key] && roleValues[key].unit) common.unit = roleValues[key].unit;

                        common.onChange = (value) => {
                            if (!knownDevices[deviceId].device) {
                                adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                return;
                            }

                            const controlData = {
                                channel: diffuserLight.channel
                            };
                            controlData[key] = (key === 'rgb') ? convertHexToNumber(value) : value;
                            if (key === 'onoff') {
                                controlData[key] = controlData[key] ? 1 : 0;
                            }
                            switch (key) {
                                /*
                                    MODE_LUMINANCE = 4
                                    MODE_TEMPERATURE = 2
                                    MODE_RGB = 1
                                    MODE_RGB_LUMINANCE = 5
                                    MODE_TEMPERATURE_LUMINANCE = 6
                                */
                                case 'rgb':
                                    controlData.mode = 1;
                                    break;
                                case 'temperature':
                                    controlData.mode = 2;
                                    break;
                                case 'luminance':
                                    controlData.mode = values[`light-${diffuserLight.channel}-mode`];
                                    break;
                            }
                            knownDevices[deviceId].device.controlDiffusorLight(data.diffuser.type, controlData, (err, res) => {
                                adapter.log.debug(`Diffusor-Light Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                adapter.log.debug(`${deviceId}.${diffuserLight.channel}-${key}: set light value ${JSON.stringify(controlData)}`);
                            });
                        };
                        objs.push(common);
                    }
                });
            }
        } else {
            adapter.log.info('Unsupported Diffusor type. Please send the following line to developer!');
            adapter.log.info(JSON.stringify(data));
        }
    }

    objs.forEach((obj) => {
        const id = obj.id;
        delete obj.id;
        const onChange = obj.onChange;
        delete obj.onChange;
        //console.log('Create: ' + deviceId + '.' + id);
        objectHelper.setOrUpdateObject(`${deviceId}.${id}`, {
            type: 'state',
            common: obj
        }, values[id], onChange);
    });
}

async function initDevice(deviceId, deviceDef, device, callback) {
    if (!knownDevices[deviceId]) {
        knownDevices[deviceId] = {};
    }
    knownDevices[deviceId].device = device;
    knownDevices[deviceId].deviceDef = deviceDef;

    objectHelper.setOrUpdateObject(deviceId, {
        type: 'device',
        common: {
            name: deviceDef.devName || `Device ${deviceId}`,
            statusStates: {
                onlineId: `${adapter.namespace}.${deviceId}.online`
            }
        },
        native: deviceDef
    });
    objectHelper.setOrUpdateObject(`${deviceId}.online`, {
        type: 'state',
        common: {
            name: 'Device online status',
            type: 'boolean',
            role: 'indicator.reachable',
            read: true,
            write: false
        }
    }, false);

    objectHelper.setOrUpdateObject(`${deviceId}.disabled`, {
        type: 'state',
        common: {
            name: 'Device disable status to ignore connection errors',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
            def: false
        }
    },(value) => {
        knownDevices[deviceId].disabled = !!value;
        adapter.setState(`${deviceId}.disabled`, knownDevices[deviceId].disabled, true);
    });
    try {
        const disabledState = await adapter.getStateAsync(`${deviceId}.disabled`);
        if (disabledState && disabledState.val !== undefined) {
            knownDevices[deviceId].disabled = !!disabledState.val;
        }
    } catch {
        // ignore
    }

    try {
        const knownIpState = await adapter.getStateAsync(`${deviceId}.ip`);
        const localConnectionState = await adapter.getStateAsync(`${deviceId}.localConnection`);
        let localConnection = ((localConnectionState && typeof localConnectionState.val === 'boolean') ? localConnectionState.val : true) && !adapter.config.noDirectLocalCommunication;
        if (localConnection && knownIpState && typeof knownIpState.val === 'string' && knownIpState.val.length) {
            device.setKnownLocalIp(knownIpState.val);
            // try to get with known local IP, remove again if not the right one
            device.getSystemAllData((err, deviceAllData) => {
                if (!err && deviceAllData && deviceAllData.all && deviceAllData.all.system && deviceAllData.all.system.hardware && deviceAllData.all.system.hardware.uuid === deviceId) {
                    initDeviceData(deviceId, deviceDef, device, deviceAllData, callback);
                } else {
                    if (!adapter.config.onlyLocalCommunicationToQueryData) {
                        adapter.log.debug(`Device ${deviceId} local IP seems incorrect ... retry via cloud: ${err}`);
                        device.removeKnownLocalIp();
                    } else {
                        adapter.log.debug(`Device ${deviceId} locally unreachable? ... retry once more: ${err}`);
                    }
                    device.getSystemAllData((err, deviceAllData) => {
                        !knownDevices[deviceId].disabled && (err || !deviceAllData) && adapter.log.info(`Can not get Data for Device ${deviceId}: ${err}`);
                        knownDevices[deviceId].disabled && (err || !deviceAllData) && adapter.log.debug(`Can not get Data for Device ${deviceId}: ${err}`);
                        initDeviceData(deviceId, deviceDef, device, deviceAllData, callback)
                    });
                }
            });
        } else {
            device.getSystemAllData((err, deviceAllData) => {
                !knownDevices[deviceId].disabled && err && adapter.log.info(`Can not get Data for Device ${deviceId}: ${err}`);
                knownDevices[deviceId].disabled && err && adapter.log.debug(`Can not get Data for Device ${deviceId}: ${err}`);
                initDeviceData(deviceId, deviceDef, device, deviceAllData, callback);
            });
        }
    } catch (e) {
        adapter.log.error(e.message);
        adapter.log.error(e.stack);
        // ignore
        initDeviceData(deviceId, deviceDef, device, undefined, callback);
    }
}

function initDeviceData(deviceId, deviceDef, device, deviceAllData, callback) {
    function reInitDevice() {
        if (knownDevices[deviceId].reconnectTimeout) {
            clearTimeout(knownDevices[deviceId].reconnectTimeout);
        }
        knownDevices[deviceId].reconnectTimeout = setTimeout(() => {
            knownDevices[deviceId].reconnectTimeout = null;
            initDevice(deviceId, deviceDef, device);
        }, 60000);
    }

    adapter.log.debug(`${deviceId} All-Data: ${JSON.stringify(deviceAllData)}`);
    if (!deviceAllData) {
        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Data for Device ${deviceId}: ${JSON.stringify(deviceAllData)}`);
        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Data for Device ${deviceId}: ${JSON.stringify(deviceAllData)}`);
        reInitDevice()
        objectHelper.processObjectQueue(() => {
            callback && callback();
        });
        return;
    }
    knownDevices[deviceId].deviceAllData = deviceAllData;

    adapter.getState(`${deviceId}.localConnection`, (err, state) => {
        let localConnection = ((!err && state && typeof state.val === 'boolean') ? state.val : true) && !adapter.config.noDirectLocalCommunication;
        adapter.log.debug(`${deviceId} Use local connection: ${localConnection}`);
        if (deviceAllData && deviceAllData.all && deviceAllData.all.system && deviceAllData.all.system.firmware && deviceAllData.all.system.firmware.innerIp) {
            localConnection = localConnection && !!deviceAllData.all.system.firmware.innerIp;
            objectHelper.setOrUpdateObject(`${deviceId}.ip`, {
                type: 'state',
                common: {
                    name: 'Device IP',
                    type: 'string',
                    role: 'info.ip',
                    read: true,
                    write: false
                }
            }, deviceAllData.all.system.firmware.innerIp);
            objectHelper.setOrUpdateObject(`${deviceId}.localConnection`, {
                type: 'state',
                common: {
                    name: 'Connect locally first',
                    type: 'boolean',
                    role: 'switch',
                    read: true,
                    write: true,
                }
            }, [], localConnection, value => {
                if (adapter.config.noDirectLocalCommunication) {
                    adapter.log.info(`Can not change local connection for device ${deviceId} because adapter is configured to not use local connections at all!`);
                    value = false;
                }
                if (value) {
                    knownDevices[deviceId].device.setKnownLocalIp(deviceAllData.all.system.firmware.innerIp);
                } else {
                    knownDevices[deviceId].device.removeKnownLocalIp();
                }
                adapter.setState(`${deviceId}.localConnection`, value, true);
            });
            adapter.log.debug(`${deviceId} Use local connection: ${localConnection}`);
            if (localConnection) {
                knownDevices[deviceId].device.setKnownLocalIp(deviceAllData.all.system.firmware.innerIp);
            } else {
                knownDevices[deviceId].device.removeKnownLocalIp();
            }
        }

        device.getSystemAbilities((err, deviceAbilities) => {
            adapter.log.debug(`${deviceId} Abilities: ${JSON.stringify(deviceAbilities)}`);
            if (err || !deviceAbilities || !deviceAbilities.ability) {
                !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Abilities for Device ${deviceId}: ${err} / ${JSON.stringify(deviceAbilities)}`);
                knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Abilities for Device ${deviceId}: ${err} / ${JSON.stringify(deviceAbilities)}`);
                reInitDevice()
                objectHelper.processObjectQueue(() => {
                    callback && callback();
                });
                return;
            }
            knownDevices[deviceId].deviceAbilities = deviceAbilities;

            if (!deviceAbilities.ability['Appliance.Control.ToggleX'] && !deviceAbilities.ability['Appliance.Control.Toggle'] && !deviceAbilities.ability['Appliance.Control.Electricity'] && !deviceAbilities.ability['Appliance.GarageDoor.State'] && !deviceAbilities.ability['Appliance.Control.Light'] && !deviceAbilities.ability['Appliance.Digest.Hub'] && !deviceAbilities.ability['Appliance.Control.Spray'] && !deviceAbilities.ability['Appliance.Control.Diffuser.Spray'] && !deviceAbilities.ability['Appliance.Control.Diffuser.Light'] && !deviceAbilities.ability['Appliance.RollerShutter.State'] && !deviceAbilities.ability['Appliance.Control.Thermostat.Mode'] && !deviceAbilities.ability['Appliance.Hub.Sensor.Smoke'] && !deviceAbilities.ability['Appliance.Hub.Sensor.DoorWindow'] && !deviceAbilities.ability['Appliance.Hub.ToggleX']) {
                adapter.log.info(`Known abilities not supported by Device ${deviceId}: send next line from disk to developer`);
                adapter.log.info(JSON.stringify(deviceAbilities));
                objectHelper.processObjectQueue(() => {
                    callback && callback();
                });
                return;
            }

            if (deviceAllData.all &&
                (deviceAbilities.ability['Appliance.Control.ToggleX'] || deviceAbilities.ability['Appliance.Control.Toggle'] || deviceAbilities.ability['Appliance.GarageDoor.State'] || deviceAbilities.ability['Appliance.Control.Light'] || deviceAbilities.ability['Appliance.Digest.Hub'] || deviceAbilities.ability['Appliance.Control.Spray'] || deviceAbilities.ability['Appliance.Control.Diffuser.Spray'] || deviceAbilities.ability['Appliance.Control.Diffuser.Light'] || deviceAbilities.ability['Appliance.Control.Thermostat.Mode'] || deviceAbilities.ability['Appliance.Control.Thermostat.Mode'] || deviceAbilities.ability['Appliance.Hub.Sensor.Smoke'] || deviceAbilities.ability['Appliance.Hub.Sensor.DoorWindow'] || deviceAbilities.ability['Appliance.Hub.ToggleX'])) {
                initDeviceObjects(deviceId, deviceDef.channels, deviceAllData.all.digest || deviceAllData.all.control);
            }

            let objAsyncCount = 0;

            if (deviceAbilities.ability['Appliance.Control.Electricity']) {
                objAsyncCount++;
                device.getControlElectricity((err, res) => {
                    if (!err && res) {
                        //{"electricity":{"channel":0,"current":0,"voltage":2331,"power":0}}
                        adapter.log.debug(`${deviceId} Electricity: ${JSON.stringify(res)}`);
                        initDeviceObjects(deviceId, deviceDef.channels, res);

                        pollElectricity(deviceId);
                    } else {
                        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Electricity data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Electricity data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        reInitDevice()
                    }
                    if (!--objAsyncCount) {
                        objectHelper.processObjectQueue(() => {
                            callback && callback();
                            callback = null;
                        });
                    }
                });
            }

            if (deviceAbilities.ability['Appliance.Control.Consumption']) {
                device.getControlPowerConsumption((err, res) => {
                    adapter.log.info(`${deviceId} Report to developer Consumption: ${JSON.stringify(res)}`);
                });
            }

            if (deviceAbilities.ability['Appliance.Control.ConsumptionX']) {
                objectHelper.setOrUpdateObject(`${deviceId}.consumption`, {
                    type: 'channel',
                    common: {
                        name: 'Consumption',
                    }
                }, ['name']);

                objectHelper.setOrUpdateObject(`${deviceId}.consumption.today`, {
                    type: 'state',
                    common: {
                        name: 'Consumption Today',
                        type: 'number',
                        read: true,
                        write: false,
                        unit: 'kWh',
                        role: 'value.power.consumption'
                    }
                }, ['name']);

                objectHelper.setOrUpdateObject(`${deviceId}.consumption.yesterday`, {
                    type: 'state',
                    common: {
                        name: 'Consumption Yesterday',
                        type: 'number',
                        read: true,
                        write: false,
                        unit: 'kWh',
                        role: 'value.power.consumption'
                    }
                }, ['name']);

                objectHelper.setOrUpdateObject(`${deviceId}.consumption.data`, {
                    type: 'state',
                    common: {
                        name: 'Consumption Data',
                        type: 'string',
                        read: true,
                        write: false,
                        role: 'json'
                    }
                }, ['name']);

                pollConsumptionX(deviceId, 30 + Math.floor(Math.random() * 30));
            }

            if (deviceAbilities.ability['Appliance.System.DNDMode']) {
                objAsyncCount++;
                device.getSystemDNDMode((err, res) => {
                    if (!err && res) {
                        //{"DNDMode":{"mode":1}}
                        adapter.log.debug(`${deviceId} DND-Mode: ${JSON.stringify(res)}`);
                        initDeviceObjects(deviceId, deviceDef.channels, res);
                    } else {
                        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get DNDMode data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get DNDMode data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        reInitDevice()
                    }

                    if (!--objAsyncCount) {
                        objectHelper.processObjectQueue(() => {
                            callback && callback();
                            callback = null;
                        });
                    }
                });
            }

            if (deviceAbilities.ability['Appliance.RollerShutter.State']) {
                objAsyncCount++;
                device.getRollerShutterState((err, res) => {
                    if (!err && res && res.state) {
                        res.state.forEach(val => {
                            if (val.state === undefined) {
                                return;
                            }
                            const commonUp = {};
                            commonUp.type = 'boolean';
                            commonUp.read = true;
                            commonUp.write = true;
                            commonUp.name = `${val.channel}-up`;
                            commonUp.role = 'button.open.blind';

                            const onChangeUp = (value) => {
                                if (!value) {
                                    return;
                                }
                                if (!knownDevices[deviceId].device) {
                                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                    return;
                                }

                                knownDevices[deviceId].device.controlRollerShutterUp(val.channel, (err, res) => {
                                    adapter.log.debug(`RollerShutter State Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                });
                            };
                            objectHelper.setOrUpdateObject(`${deviceId}.${commonUp.name}`, {
                                type: 'state',
                                commonUp
                            }, val.state === 1, onChangeUp);

                            const commonDown = {};
                            commonDown.type = 'boolean';
                            commonDown.read = true;
                            commonDown.write = true;
                            commonDown.name = `${val.channel}-down`;
                            commonDown.role = 'button.close.blind';

                            const onChangeDown = (value) => {
                                if (!value) {
                                    return;
                                }
                                if (!knownDevices[deviceId].device) {
                                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                    return;
                                }

                                knownDevices[deviceId].device.controlRollerShutterDown(val.channel, (err, res) => {
                                    adapter.log.debug(`RollerShutter State Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                });
                            };
                            objectHelper.setOrUpdateObject(`${deviceId}.${commonDown.name}`, {
                                type: 'state',
                                commonDown
                            }, val.state === 2, onChangeDown);

                            const commonStop = {};
                            commonStop.type = 'boolean';
                            commonStop.read = true;
                            commonStop.write = true;
                            commonStop.name = `${val.channel}-stop`;
                            commonStop.role = 'button.stop';

                            const onChangeStop = (value) => {
                                if (!value) {
                                    return;
                                }
                                if (!knownDevices[deviceId].device) {
                                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                    return;
                                }

                                knownDevices[deviceId].device.controlRollerShutterStop(val.channel, (err, res) => {
                                    adapter.log.debug(`RollerShutter State Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                });
                            };
                            objectHelper.setOrUpdateObject(`${deviceId}.${commonStop.name}`, {
                                type: 'state',
                                commonStop
                            }, val.state === 0, onChangeStop);
                        });
                    } else {
                        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Roller/Shutter data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Roller/Shutter data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        reInitDevice()
                    }

                    if (!--objAsyncCount) {
                        objectHelper.processObjectQueue(() => {
                            callback && callback();
                            callback = null;
                        });
                    }
                });

                objAsyncCount++;
                device.getRollerShutterPosition((err, res) => {
                    if (!err && res && res.position) {
                        res.position.forEach(val => {
                            const common = {};
                            if (val.position !== undefined) {
                                common.type = 'number';
                                common.read = true;
                                common.write = true;
                                common.name = `${val.channel}-position`;
                                common.role = 'value.blind';
                                common.unit = '%';
                                common.min = 0;
                                common.max = 100;

                                const onChangePosition = (value) => {
                                    value = parseInt(value, 10);
                                    if (isNaN(value) || value < 0 || value > 100) {
                                        return;
                                    }

                                    if (!knownDevices[deviceId].device) {
                                        adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                        return;
                                    }

                                    knownDevices[deviceId].device.controlRollerShutterPosition(val.channel, value, (err, res) => {
                                        adapter.log.debug(`RollerShutter State Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                    });
                                };
                                objectHelper.setOrUpdateObject(`${deviceId}.${common.name}`, {
                                    type: 'state',
                                    common
                                }, val.position, onChangePosition);
                            }
                        });
                    } else {
                        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Roller/Shutter position data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Roller/Shutter position data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        reInitDevice()
                    }

                    if (!--objAsyncCount) {
                        objectHelper.processObjectQueue(() => {
                            callback && callback();
                            callback = null;
                        });
                    }
                });
            }

            if (deviceAbilities.ability['Appliance.Control.FilterMaintenance']) {
                objAsyncCount++;
                device.getFilterMaintenance((err, res) => {
                    if (!err && res && res.filter) {
                        res.filter.forEach(val => {
                            const common = {};
                            common.type = 'number';
                            common.read = true;
                            common.write = false;
                            common.name = `${val.channel}-filter-life`;
                            common.unit = '%';
                            common.min = 0;
                            common.max = 100;
                            common.role = 'value';

                            objectHelper.setOrUpdateObject(`${deviceId}.${common.name}`, {
                                type: 'state',
                                common
                            }, val.life);
                        });
                    } else {
                        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Filter Maintenance data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Filter Maintenance data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        reInitDevice()
                    }

                    if (!--objAsyncCount) {
                        objectHelper.processObjectQueue(() => {
                            callback && callback();
                            callback = null;
                        });
                    }
                });
            }

            if (deviceAbilities.ability['Appliance.Control.PhysicalLock']) {
                objAsyncCount++;
                device.getPhysicalLockState((err, res) => {
                    if (!err && res && res.lock) {
                        res.lock.forEach(val => {
                            const common = {};
                            common.type = 'boolean';
                            common.read = true;
                            common.write = true;
                            common.name = `${val.channel}-lock`;
                            common.role = defineRole(common);

                            const onChangeLockState = (value) => {
                                if (!value) {
                                    return;
                                }
                                if (!knownDevices[deviceId].device) {
                                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                    return;
                                }

                                knownDevices[deviceId].device.controlPhysicalLock(val.channel, !!value,(err, res) => {
                                    adapter.log.debug(`Physical Lock State Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                });
                            };

                            objectHelper.setOrUpdateObject(`${deviceId}.${common.name}`, {
                                type: 'state',
                                common
                            }, undefined/*!!val.onoff*/, onChangeLockState);
                        });
                    } else {
                        !knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Physical Lock data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Physical Lock data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        reInitDevice()
                    }

                    if (!--objAsyncCount) {
                        objectHelper.processObjectQueue(() => {
                            callback && callback();
                            callback = null;
                        });
                    }
                });
            }

            if (deviceAbilities.ability['Appliance.Control.Fan']) {
                objAsyncCount++;
                device.getFanState((err, res) => {
                    if (err || !res) {
                        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Fan data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Fan data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        res = {fan: [{speed: null, maxSpeed:4, channel:0 }]};
                        // We simulate a value for now because getting it do not work
                    }
                    if (!err && res && res.fan) {
                        res.fan.forEach(val => {
                            const common = {};
                            common.type = 'number';
                            common.read = true;
                            common.write = true;
                            common.name = `${val.channel}-speed`;
                            common.role = defineRole(common);
                            common.min = 1;
                            common.max = val.maxSpeed;
                            if (val.maxSpeed === 4) {
                                common.states = {
                                    1: 'Sleep',
                                    2: 'Low',
                                    3: 'Medium',
                                    4: 'High'
                                };
                            }

                            const onChangeFanSpeed = (value) => {
                                if (!value) {
                                    return;
                                }
                                if (!knownDevices[deviceId].device) {
                                    adapter.log.debug(`${deviceId} Device communication not initialized ...`);
                                    return;
                                }
                                if (typeof value !== 'number') {
                                    value = parseInt(value, 10);
                                }

                                if (isNaN(value) || value < 1 || value > val.maxSpeed) {
                                    adapter.log.warn(`Invalid fan speed value ${value} for ${deviceId}! Needs to be between 1 and ${val.maxSpeed}`);
                                    return;
                                }

                                knownDevices[deviceId].device.controlFan(val.channel, value, val.maxSpeed, (err, res) => {
                                    adapter.log.debug(`Fan Speed Response: err: ${err}, res: ${JSON.stringify(res)}`);
                                });
                            };

                            objectHelper.setOrUpdateObject(`${deviceId}.${common.name}`, {
                                type: 'state',
                                common
                            }, undefined/*val.speed*/, onChangeFanSpeed);
                        });
                    } else {
                        !knownDevices[deviceId].disabled && adapter.log.warn(`Can not get Fan data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        knownDevices[deviceId].disabled && adapter.log.debug(`Can not get Fan data for Device ${deviceId}: ${err} / ${JSON.stringify(res)}`);
                        reInitDevice()
                    }

                    if (!--objAsyncCount) {
                        objectHelper.processObjectQueue(() => {
                            callback && callback();
                            callback = null;
                        });
                    }
                });
            }

            if (!objAsyncCount) {
                objectHelper.processObjectQueue(() => {
                    callback && callback();
                    callback = null;
                });
            }
        });
    });
}

function initDone() {
    adapter.log.info('Devices initialized');
    adapter.subscribeStates('*');
    if (adapter.supportsFeature && adapter.supportsFeature('ADAPTER_DEL_OBJECT_RECURSIVE')) {
        adapter.getDevices((err, devices) => {
            if (devices && devices.length) {
                devices.forEach((device) => {
                    if (device._id && device.native) {
                        const id = device._id.substr(adapter.namespace.length + 1);
                        if (!knownDevices[id]) {
                            adapter.log.info(`Found old/unknown device ${id}: delete states`);
                            adapter.delObject(id, {recursive: true});
                        }
                    }
                });
            }
        });
    }
}

function pollConsumptionX(deviceId, delay) {
    if (!knownDevices[deviceId].deviceAbilities || !knownDevices[deviceId].deviceAbilities.ability['Appliance.Control.ConsumptionX']) return;
    if (!delay) {
        delay = (adapter.config.consumptionPollingInterval || 30) * 60;
    }
    if (knownDevices[deviceId].consumptionXPollTimeout) {
        adapter.log.debug(`${deviceId} ConsumptionX schedule cleared`);
        clearTimeout(knownDevices[deviceId].consumptionXPollTimeout);
        knownDevices[deviceId].consumptionXPollTimeout = null;
    }
    adapter.log.debug(`${deviceId} ConsumptionX scheduled in : ${delay}s`);
    knownDevices[deviceId].consumptionXPollTimeout = setTimeout(() => {
        knownDevices[deviceId].consumptionXPollTimeout = null;
        adapter.log.debug(`${deviceId} ConsumptionX query executed now`);
        knownDevices[deviceId].device.getControlPowerConsumptionX((err, res) => {
            if (!err) {
                adapter.log.debug(`${deviceId} ConsumptionX: ${JSON.stringify(res)}`);
                setValuesConsumptionX(deviceId, res);
            }
            pollConsumptionX(deviceId);
        });
    }, delay * 1000);
}

function pollElectricity(deviceId, delay) {
    if (!knownDevices[deviceId].deviceAbilities || !knownDevices[deviceId].deviceAbilities.ability['Appliance.Control.Electricity']) return;
    if (!delay) delay = adapter.config.electricityPollingInterval || 30;
    if (knownDevices[deviceId].electricityPollTimeout) {
        adapter.log.debug(`${deviceId} Electricity schedule cleared`);
        clearTimeout(knownDevices[deviceId].electricityPollTimeout);
        knownDevices[deviceId].electricityPollTimeout = null;
    }
    adapter.log.debug(`${deviceId} Electricity scheduled in : ${delay}s`);
    knownDevices[deviceId].electricityPollTimeout = setTimeout(() => {
        knownDevices[deviceId].electricityPollTimeout = null;
        adapter.log.debug(`${deviceId} Electricity query executed now`);
        knownDevices[deviceId].device.getControlElectricity((err, res) => {
            if (!err) {
                //{"electricity":{"channel":0,"cut":0,"voltage":2331,"power":0}}
                adapter.log.debug(`${deviceId} Electricity: ${JSON.stringify(res)}`);
                setValuesElectricity(deviceId, res);
            }
            pollElectricity(deviceId);
        });
    }, delay * 1000);
}

function setValuesToggleX(deviceId, payload) {
    // {"togglex":{"channel":1,"onoff":1,"lmTime":1540825748}} OR
    // {"togglex":[{"channel":0,"onoff":0,"lmTime":1542037296},{"channel":1,"onoff":0,"lmTime":1542037296},{"channel":2,"onoff":0,"lmTime":1542037296},{"channel":3,"onoff":0,"lmTime":1542037296},{"channel":4,"onoff":0,"lmTime":1542037296}]}
    if (payload && payload.togglex) {
        if (!Array.isArray(payload.togglex)) {
            payload.togglex = [payload.togglex];
        }
        payload.togglex.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}`, !!val.onoff, true);
        });
        pollElectricity(deviceId, 2);
    }
}

function setValuesHubToggleX(deviceId, payload) {
    // {"togglex":[{"id":"000013CD","onoff":1}]}
    if (payload && payload.togglex) {
        if (!Array.isArray(payload.togglex)) {
            payload.togglex = [payload.togglex];
        }
        payload.togglex.forEach((val) => {
            adapter.setState(`${deviceId}.${val.id}.switch`, !!val.onoff, true);
        });
    }
}

function setValuesSpray(deviceId, payload) {
    // {"spray":[{"channel":0,"mode":1,"lmTime":1567450159,"lastMode":0,"onoffTime":1567450159}]}
    if (payload && payload.spray) {
        if (!Array.isArray(payload.spray)) {
            payload.spray = [payload.spray];
        }
        payload.spray.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}-mode`, val.mode, true);
        });
    }
}

function setValuesHubBattery(deviceId, payload) {
    // {"battery":[{"id":"000013CD","value":1}]}
    if (payload && payload.battery) {
        if (!Array.isArray(payload.battery)) {
            payload.battery = [payload.battery];
        }
        payload.battery.forEach((val) => {
            adapter.setState(`${deviceId}.${val.id}.battery`, val.value, true);
        });
    }
}

function setValuesHubOnline(deviceId, payload) {
    // {"online":[{"status":1,"lastActiveTime":1641599783,"id":"0100D4DC"}]}
    if (payload && payload.online) {
        if (!Array.isArray(payload.online)) {
            payload.online = [payload.online];
        }
        payload.online.forEach((val) => {
            adapter.setState(`${deviceId}.${val.id}.online`, parseInt(val.status) === 1, true);
        });
    }
}

function setValuesHubMts100Temperature(deviceId, payload) {
    // {"temperature":[{"id":"000013CD","currentSet":350,"custom":350,"comfort":260,"economy":155}]}
    // temperature": [{
    // 			"id": "000013CD",
    // 			"room": 240,
    // 			"currentSet": 215,
    // 			"custom": 50,
    // 			"comfort": 215,
    // 			"economy": 200,
    // 			"max": 350,
    // 			"min": 50,
    // 			"heating": 0,
    //          "openWindow": 1
    // 		}]
    if (payload && payload.temperature) {
        if (!Array.isArray(payload.temperature)) {
            payload.temperature = [payload.temperature];
        }
        payload.temperature.forEach((val) => {
            if (val.room !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.room`, val.room / 10, true);
            }
            if (val.custom !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.custom`, val.custom / 10, true);
            }
            if (val.currentSet !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.currentSet`, val.currentSet / 10, true);
            }
            if (val.comfort !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.comfort`, val.comfort / 10, true);
            }
            if (val.economy !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.economy`, val.economy / 10, true);
            }
            if (val.away !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.away`, val.away / 10, true);
            }
            if (val.heating !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.heating`, !!val.heating, true);
            }
            if (val.openWindow !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.openWindow`, !!val.openWindow, true);
            }
        });
    }
}

function setValuesHubMts100TempHum(deviceId, payload) {
    // {"latestTime":1574713737,"latestTemperature":224,"latestHumidity":520,"voltage":2922}
    if (payload && payload.tempHum) {
        if (!Array.isArray(payload.tempHum)) {
            payload.tempHum = [payload.tempHum];
        }
        payload.tempHum.forEach((val) => {
            if (val.latestTemperature !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.latestTemperature`, {
                    val: val.latestTemperature / 10,
                    ts: val.latestTime * 1000
                }, true);
            }
            if (val.latestHumidity !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.latestHumidity`, {
                    val: val.latestHumidity / 10,
                    ts: val.latestTime * 1000
                }, true);
            }
            if (val.voltage !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.voltage`, {
                    val: val.voltage / 1000,
                    ts: val.latestTime * 1000
                }, true);
            }
        });
    }
}

function setValuesHubMts100Mode(deviceId, payload) {
    // {"mode":[{"id":"000013CD","state":0}]}
    if (payload && payload.mode) {
        if (!Array.isArray(payload.mode)) {
            payload.mode = [payload.mode];
        }
        payload.mode.forEach((val) => {
            adapter.setState(`${deviceId}.${val.id}.mode`, val.state, true);
        });
    }
}

function setValuesLight(deviceId, payload) {
    // {"light":{"capacity":6,"channel":0,"rgb":127,"temperature":80,"luminance":100}}
    // {"light":{"capacity":5,"channel":0,"rgb":6947071,"temperature":70,"luminance":99,"gradual":0,"transform":-1}}
    if (payload && payload.light) {
        for (let key in payload.light) {
            if (!payload.light.hasOwnProperty(key)) continue;
            if (key === 'channel' || key === 'capacity') continue;
            if (key === 'rgb') payload.light[key] = convertNumberToHex(payload.light[key]);
            adapter.setState(`${deviceId}.${payload.light.channel}-${key}`, payload.light[key], true);
        }
    }
}

function setValuesGarageDoor(deviceId, payload) {
    // {"state":[{"channel":0,"open":1,"lmTime":1559850976}],"reason":{"bootup":{"timestamp":1559851565}}} OR
    // {"state":[{"channel":0,"open":1,"lmTime":1559851588}]}
    if (payload && payload.state) {
        if (!Array.isArray(payload.state)) {
            payload.state = [payload.state];
        }
        payload.state.forEach((val) => {
            if (val.execute !== 1) {
                adapter.setState(`${deviceId}.${val.channel}-garageDoor`, !!val.open, true);
            }
            adapter.setState(`${deviceId}.${val.channel}-garageDoorWorking`, !!val.execute, true);
        });
    }
}

function setValuesToggle(deviceId, payload) {
    // {"toggle":{"onoff":1,"lmTime":1542311107}}
    if (payload && payload.toggle) {
        adapter.setState(`${deviceId}.0-switch`, !!payload.toggle.onoff, true);
        pollElectricity(deviceId, 2);
    }
}

function setValuesElectricity(deviceId, payload) {
    // {"electricity":{"channel":0,"current":0,"voltage":2331,"power":0}}
    if (payload && payload.electricity) {
        const channel = payload.electricity.channel;
        for (let key in payload.electricity) {
            if (!payload.electricity.hasOwnProperty(key)) continue;
            if (key === 'channel') continue;

            adapter.setState(`${deviceId}.${channel}-${key}`, Math.floor(payload.electricity[key] * Math.pow(10, (roleValues[key] ? roleValues[key].scale || 0 : 0)) * 100) / 100, true);
        }
    }
}

function setValuesConsumptionX(deviceId, payload) {
    // {"consumptionx":[{"date":"2022-12-31","time":1672527480,"value":0},...}
    if (payload && payload.consumptionx) {
        const d = new Date();
        const todayStr = `${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}-${('0' + d.getDate()).slice(-2)}`;
        d.setDate(d.getDate() - 1);
        const yesterdayStr = `${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}-${('0' + d.getDate()).slice(-2)}`;
        const todayData = payload.consumptionx.find((val) => val.date === todayStr);
        const yesterdayData = payload.consumptionx.find((val) => val.date === yesterdayStr);
        adapter.setState(`${deviceId}.consumption.today`, todayData ? todayData.value / 1000 : 0, true);
        adapter.setState(`${deviceId}.consumption.yesterday`, yesterdayData ? yesterdayData.value / 1000 : 0, true);
        adapter.setState(`${deviceId}.consumption.data`, JSON.stringify(payload.consumptionx), true);
    }
}

function setValuesDiffuserLight(deviceId, payload) {
    // {"type":"mod100","light":[{"rgb":16774912,"onoff":0,"mode":1,"luminance":71,"lmTime":1618222769,"channel":0}]}
    if (payload && payload.light) {
        if (!Array.isArray(payload.light)) {
            payload.light = [payload.light];
        }
        payload.light.forEach(light => {
            for (let key in light) {
                if (!light.hasOwnProperty(key)) continue;
                if (key === 'channel') continue;
                if (key === 'rgb') light[key] = convertNumberToHex(light[key]);
                if (key === 'onoff') light[key] = !!light[key];
                    adapter.setState(`${deviceId}.light-${light.channel}-${key}`, light[key], true);
            }
        });
    }
}

function setValuesDiffuserSpray(deviceId, payload) {
    // {"type":"mod100","spray":[{"mode":1,"lmTime":1618222739,"channel":0}]}
    if (payload && payload.spray) {
        if (!Array.isArray(payload.spray)) {
            payload.spray = [payload.spray];
        }
        payload.spray.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}-mode`, val.mode, true);
        });
    }
}

function setValuesRollerShutterState(deviceId, payload) {
    // {"state":[{"state":1,"channel":0}]}
    if (payload && payload.state) {
        if (!Array.isArray(payload.state)) {
            payload.state = [payload.state];
        }
        payload.state.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}-up`, val.state === 1, true);
            adapter.setState(`${deviceId}.${val.channel}-down`, val.state === 2, true);
            adapter.setState(`${deviceId}.${val.channel}-stop`, val.state === 0, true);
        });
    }
}

function setValuesFilterMaintenance(deviceId, payload) {
    // {"filter":[{"lmTime":1662013898,"life":100,"channel":0}]}
    if (payload && payload.filter) {
        if (!Array.isArray(payload.filter)) {
            payload.filter = [payload.filter];
        }
        payload.filter.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}-filter-life`, val.life, true);
        });
    }
}

function setValuesPhysicalLock(deviceId, payload) {
    // {"lock":[{"onoff":1,"channel":0}]}
    if (payload && payload.lock) {
        if (!Array.isArray(payload.lock)) {
            payload.lock = [payload.lock];
        }
        payload.lock.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}-lock`, !!val.onoff, true);
        });
    }
}

function setValuesFan(deviceId, payload) {
    // {"fan":[{"speed":1,"maxSpeed":4,"channel":0}]}
    if (payload && payload.fan) {
        if (!Array.isArray(payload.fan)) {
            payload.fan = [payload.fan];
        }
        payload.fan.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}-speed`, val.speed, true);
        });
    }
}

function setValuesRollerShutterPosition(deviceId, payload) {
    // {"position":[{"position":0,"channel":0}]}
    if (payload && payload.position) {
        if (!Array.isArray(payload.position)) {
            payload.position = [payload.position];
        }
        payload.position.forEach((val) => {
            adapter.setState(`${deviceId}.${val.channel}-position`, val.position, true);
        });
    }
}

function setValuesThermostatMode(deviceId, payload) {
    // {"mode":[{"warning":0,"targetTemp":120,"state":0,"onoff":1,"mode":2,"min":50,"max":350,"manualTemp":240,"lmTime":1639427735,"heatTemp":260,"ecoTemp":120,"currentTemp":245,"coolTemp":180,"channel":0}]}
    if (payload && payload.mode) {
        if (!Array.isArray(payload.mode)) {
            payload.mode = [payload.mode];
        }
        payload.mode.forEach((mode) => {
            for (let key in mode) {
                if (!mode.hasOwnProperty(key)) continue;
                if (key === 'channel' || key === 'min' || key === 'max') continue;
                if (key === 'onoff' || key === 'state' || key === 'warning') {
                    mode[key] = !!mode[key];
                }
                if (roleValues[key] && roleValues[key].scale !== undefined) {
                    mode[key] = Math.floor(mode[key] * Math.pow(10, roleValues[key].scale) * 100) / 100;
                }
                adapter.setState(`${deviceId}.${mode.channel}-mode-${key}`, mode[key], true);
            }
        });
    }
}

function setValuesHubSmokeSensor(deviceId, payload) {
    // {"smokeAlarm":[{"status":170,"id":"2800BF0A69B5"}]}
    if (payload && payload.smokeAlarm) {
        if (!Array.isArray(payload.smokeAlarm)) {
            payload.smokeAlarm = [payload.smokeAlarm];
        }
        payload.smokeAlarm.forEach((val) => {
            if (val.status !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.status`, val.status, true);
                adapter.setState(`${deviceId}.${val.id}.alarm`, val.status === 25, true);
            }
            if (val.interConn !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.interConn`, !!val.interConn, true);
            }
        });
    }
}

function setValuesHubDoorWindowSensor(deviceId, payload) {
    // {"smokeAlarm":[{"status":170,"id":"2800BF0A69B5"}]}
    if (payload && payload.doorWindow) {
        if (!Array.isArray(payload.doorWindow)) {
            payload.doorWindow = [payload.doorWindow];
        }
        payload.doorWindow.forEach((val) => {
            if (val.status !== undefined) {
                adapter.setState(`${deviceId}.${val.id}.status`, !!val.status, true);
            }
        });
    }
}

function setValuesThermostatWindowOpened(deviceId, payload) {
    // ??
    if (payload && payload.windowOpened) {
        if (!Array.isArray(payload.windowOpened)) {
            payload.windowOpened = [payload.windowOpened];
        }
        payload.windowOpened.forEach((windowOpened) => {
            for (let key in windowOpened) {
                if (!windowOpened.hasOwnProperty(key)) continue;
                if (key === 'channel') continue;
                if (key === 'state') {
                    windowOpened[key] = !!windowOpened[key];
                }
                adapter.setState(`${deviceId}.${windowOpened.channel}-windowOpened-${key}`, windowOpened[key], true);
            }
        });
    }
}

// main function
function main() {
    setConnected(false);
    objectHelper.init(adapter);

    // Maximum password length supported by cloud is 15 characters
    if (typeof adapter.config.password === 'string' && adapter.config.password.length > 15) {
        adapter.log.info('Password is longer then 15 characters - if it do not work please cut it at 15 characters! This might be needed for older passwords!');
    }

    adapter.config.electricityPollingInterval = parseInt(adapter.config.electricityPollingInterval, 10) || 30;
    if (isNaN(adapter.config.electricityPollingInterval) || adapter.config.electricityPollingInterval > 2147482 || ((!adapter.config.electricityPollingIntervalReChecked || adapter.config.noDirectLocalCommunication) && adapter.config.electricityPollingInterval < 30)) {
        adapter.config.electricityPollingInterval = 30;
        adapter.log.info('Electricity polling interval is invalid. Set to 30 seconds');
    }
    adapter.config.consumptionPollingInterval = parseInt(adapter.config.consumptionPollingInterval, 10) || 30;
    if (isNaN(adapter.config.consumptionPollingInterval) || adapter.config.consumptionPollingInterval > 35791 || adapter.config.consumptionPollingInterval < 10) {
        adapter.config.consumptionPollingInterval = 30;
        adapter.log.info('Consumption polling interval is invalid. Set to 30 minutes');
    }
    const options = {
        email: adapter.config.user,
        password: adapter.config.password,
        mfaCode: adapter.config.mfaCode || undefined,
        tokenData: tokenData || undefined,
        logger: adapter.log.debug,
        localHttpFirst: !adapter.config.noDirectLocalCommunication,
        onlyLocalForGet: adapter.config.onlyLocalCommunicationToQueryData,
    };

    meross = new MerossCloud(options);
    let connectedDevices = 0;

    let deviceCount = 0;
    meross.on('deviceInitialized', (deviceId, deviceDef, device) => {
        adapter.log.info(`Device ${deviceId} initialized`);
        adapter.log.debug(JSON.stringify(deviceDef));

        device.on('connected', () => {
            adapter.log.info(`Device: ${deviceId} connected`);
            if (knownDevices[deviceId] && knownDevices[deviceId].reconnectTimeout) {
                clearTimeout(knownDevices[deviceId].reconnectTimeout);
            }
            initDevice(deviceId, deviceDef, device, () => {
                device.getOnlineStatus((err, res) => {
                    adapter.log.debug(`Online ${deviceId}: ${JSON.stringify(res)}`);
                    if (err || !res || !res.online) return;
                    adapter.setState(`${deviceId}.online`, (parseInt(res.online.status) === 1), true);
                });

                if (!--deviceCount) initDone();
            });
            connectedDevices++;
            setConnected(true);
        });

        device.on('close', (error) => {
            adapter.log.info(`Device: ${deviceId} closed: ${error}`);
            adapter.setState(`${deviceId}.online`, false, true);
            setConnected((--connectedDevices > 0));
            knownDevices[deviceId] = knownDevices[deviceId] || {};
            if (knownDevices[deviceId].electricityPollTimeout) {
                clearTimeout(knownDevices[deviceId].electricityPollTimeout);
                knownDevices[deviceId].electricityPollTimeout = null;
            }
            if (knownDevices[deviceId].reconnectTimeout) {
                clearTimeout(knownDevices[deviceId].reconnectTimeout);
                knownDevices[deviceId].reconnectTimeout = null;
            }
            if (!stopped)  {
                knownDevices[deviceId].reconnectTimeout = setTimeout(() => {
                    knownDevices[deviceId].reconnectTimeout = null;
                    device.connect();
                }, 10000);
            }
        });

        device.on('error', (error) => {
            adapter.log.info(`Device: ${deviceId} error: ${error}`);
            knownDevices[deviceId] = knownDevices[deviceId] || {};
            if (knownDevices[deviceId].reconnectTimeout) {
                clearTimeout(knownDevices[deviceId].reconnectTimeout);
            }
            if (!stopped) {
                knownDevices[deviceId].reconnectTimeout = setTimeout(() => {
                    knownDevices[deviceId].reconnectTimeout = null;
                    device.connect();
                }, 10000);
            }
        });

        device.on('reconnect', () => {
            adapter.log.info(`Device: ${deviceId} reconnected`);
            if (knownDevices[deviceId] && knownDevices[deviceId].reconnectTimeout) {
                clearTimeout(knownDevices[deviceId].reconnectTimeout);
            }
        });

        device.on('data', (namespace, payload) => {
            adapter.log.debug(`Device: ${deviceId} ${namespace} - data: ${JSON.stringify(payload)}`);
            switch(namespace) {
                case 'Appliance.Control.ToggleX':
                    setValuesToggleX(deviceId, payload);
                    break;
                case 'Appliance.Control.Toggle':
                    setValuesToggle(deviceId, payload);
                    break;
                case 'Appliance.System.Online':
                    adapter.setState(`${deviceId}.online`, (parseInt(payload.online.status) === 1), true);
                    break;
                case 'Appliance.GarageDoor.State':
                    setValuesGarageDoor(deviceId, payload);
                    break;
                case 'Appliance.System.DNDMode':
                    adapter.setState(`${deviceId}.dnd`, !!payload.DNDMode.mode, true);
                    break;
                case 'Appliance.Control.Light':
                    setValuesLight(deviceId, payload);
                    break;
                case 'Appliance.Control.Spray':
                    setValuesSpray(deviceId, payload);
                    break;
                case 'Appliance.Control.Diffuser.Light':
                    setValuesDiffuserLight(deviceId, payload);
                    break;
                case 'Appliance.Control.Diffuser.Spray':
                    setValuesDiffuserSpray(deviceId, payload);
                    break;
                case 'Appliance.RollerShutter.State':
                    setValuesRollerShutterState(deviceId, payload);
                    break;
                case 'Appliance.RollerShutter.Position':
                    setValuesRollerShutterPosition(deviceId, payload);
                    break;
                case 'Appliance.Hub.ToggleX':
                    setValuesHubToggleX(deviceId, payload);
                    break;
                case 'Appliance.Hub.Battery':
                    setValuesHubBattery(deviceId, payload);
                    break;
                case 'Appliance.Hub.Online':
                    setValuesHubOnline(deviceId, payload);
                    break;
                case 'Appliance.Hub.Mts100.Temperature':
                    setValuesHubMts100Temperature(deviceId, payload);
                    break;
                case 'Appliance.Hub.Mts100.Mode':
                    setValuesHubMts100Mode(deviceId, payload);
                    break;
                case 'Appliance.Hub.Sensor.TempHum':
                    setValuesHubMts100TempHum(deviceId, payload);
                    break;
                case 'Appliance.Hub.Sensor.Smoke':
                    setValuesHubSmokeSensor(deviceId, payload);
                    break;
                case 'Appliance.Hub.Sensor.DoorWindow':
                    setValuesHubDoorWindowSensor(deviceId, payload);
                    break;
                case 'Appliance.Control.Thermostat.Mode':
                    setValuesThermostatMode(deviceId, payload);
                    break;
                case 'Appliance.Control.Thermostat.WindowOpened':
                    setValuesThermostatWindowOpened(deviceId, payload);
                    break;
                case 'Appliance.Control.FilterMaintenance':
                    setValuesFilterMaintenance(deviceId, payload);
                    break;
                case 'Appliance.Control.PhysicalLock':
                    setValuesPhysicalLock(deviceId, payload);
                    break;
                case 'Appliance.Control.Fan':
                    setValuesFan(deviceId, payload);
                    break;
                case 'Appliance.Hub.Sensor.WaterLeak':
                    if (payload && payload.waterLeak && payload.waterLeak.length) {
                        adapter.log.info(`Received unknown data ${namespace}: ${JSON.stringify(payload)}`);
                        adapter.log.info('Please send full line from logfile on disk to developer');
                    }
                    break;
                case 'Appliance.Control.ConsumptionX':
                    setValuesConsumptionX(deviceId, payload);
                    break;
                case 'Appliance.Control.Upgrade':
                case 'Appliance.System.Report':
                case 'Appliance.Control.TimerX':
                case 'Appliance.Hub.Mts100.ScheduleB':
                    break;

                default:
                    adapter.log.info(`Received unknown data ${namespace}: ${JSON.stringify(payload)}`);
                    adapter.log.info('Please send full line from logfile on disk to developer');
            }
        });
        device.on('rawData', (message) => {
            adapter.log.debug(`Device Raw: ${deviceId} - data: ${JSON.stringify(message)}`);
        });
        device.on('rawSendData', (message) => {
            adapter.log.debug(`Device Send Raw: ${deviceId} - data: ${JSON.stringify(message)}`);
        });

    });

    /*meross.on('data', (deviceId, namespace, payload) => {
        adapter.log.debug('Device(2): ' + deviceId + ' ' + namespace + ' - data: ' + JSON.stringify(payload));
    });*/

    meross.on('error', (error, deviceId) => {
        adapter.log.info(`Device: ${deviceId || 'general'} error: ${error}`);
    });

    meross.connect((error, count) => {
        if (error) {
            adapter.log.error(`Meross Connection Error: ${error}`);
            return;
        }
        deviceCount += count;
        const tokenData = meross.getTokenData();
        adapter.log.info(`Meross connected - ${count} devices initialized, Tokendata stored.`);
        adapter.extendObject('_config', {
            native: {
                tokenData
            }
        });
    });
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
