/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';

// you have to require the utils module and call adapter function
const utils   = require(__dirname + '/lib/utils'); // Get common adapter utils

const adapter = new utils.Adapter('meross');
const objectHelper = require(__dirname + '/lib/objectHelper'); // Get common adapter utils
const MerossCloud = require('meross-cloud');
let meross;

const knownDevices = {};
let connected = null;

const scaleValues = {
    'power': -3,
    'current': -3,
    'voltage': -1
};

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
        adapter.setState('info.connection', connected, true, (err) => {
            // analyse if the state could be set (because of permissions)
            if (err) adapter.log.error('Can not update connected state: ' + err);
            else adapter.log.debug('connected set to ' + connected);
        });
    }
}

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on('unload', function(callback) {
    try {
        setConnected(false);
        stopAll();
        // adapter.log.info('cleaned everything up...');
        setTimeout(callback, 3000);
    } catch (e) {
        callback();
    }
});

process.on('SIGINT', function() {
    stopAll();
    setConnected(false);
});

process.on('uncaughtException', function(err) {
    console.log('Exception: ' + err + '/' + err.toString());
    if (adapter && adapter.log) {
        adapter.log.warn('Exception: ' + err);
    }
    stopAll();
    setConnected(false);
});


// is called if a subscribed state changes
adapter.on('stateChange', function(id, state) {
    // Warning, state can be null if it was deleted
    adapter.log.debug('stateChange ' + id + ' ' + JSON.stringify(state));
    objectHelper.handleStateChange(id, state);
});


adapter.on('ready', () => {
    adapter.getForeignObject('system.config', (err, obj) => {
        if (obj && obj.native && obj.native.secret) {
            //noinspection JSUnresolvedVariable
            adapter.config.password = decrypt(obj.native.secret, adapter.config.password);
        } else {
            //noinspection JSUnresolvedVariable
            adapter.config.password = decrypt('Zgfr56gFe87jJOM', adapter.config.password);
        }
        main();
    });
});

function stopAll() {
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

function initDeviceObjects(deviceId, channels, data) {
    const objs = [];
    const values = {};

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
                    adapter.log.debug(deviceId + 'Device communication not initialized ...');
                    return;
                }

                knownDevices[deviceId].device.controlToggle((value ? 1 : 0), (err, res) => {
                    adapter.log.debug('Toggle Response: err: ' + err + ', res: ' + JSON.stringify(res));
                    adapter.log.debug(deviceId + '.0: set value ' + value);

                    if (knownDevices[deviceId].deviceAbilities.ability['Appliance.Control.Electricity']) {
                        pollElectricity(deviceId, 2);
                    }
                });
            };
        }
        else {
            adapter.log.info('Unsupported type for digest val ' + JSON.stringify(val));
            return;
        }
        objs.push(common);
    }
    else if (data && data.togglex) {
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
                if (!common.name.length && val.channel == 0) {
                    common.name = 'All';
                }
                common.role = defineRole(common);
                common.id = val.channel;
                values[val.channel] = !!val.onoff;

                common.onChange = (value) => {
                    if (!knownDevices[deviceId].device) {
                        adapter.log.debug(deviceId + 'Device communication not initialized ...');
                        return;
                    }

                    knownDevices[deviceId].device.controlToggleX(val.channel, (value ? 1 : 0), (err, res) => {
                        adapter.log.debug('ToggleX Response: err: ' + err + ', res: ' + JSON.stringify(res));
                        adapter.log.debug(deviceId + '.' + val.channel + ': set value ' + value);

                        if (knownDevices[deviceId].deviceAbilities.ability['Appliance.Control.Electricity']) {
                            pollElectricity(deviceId, 2);
                        }
                    });
                };
            }
            else {
                adapter.log.info('Unsupported type for digest val ' + JSON.stringify(val));
                return;
            }
            objs.push(common);
        });
    }
    else if (data && data.electricity) {
        if (data.electricity.channel === undefined || data.electricity.channel !==0) {
            adapter.log.info('Unsupported type for electricity val ' + JSON.stringify(data));
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
            common.role = defineRole(common);
            common.id = channel + '-' + key;
            values[common.id] = Math.floor(data.electricity[key] * Math.pow(10, (scaleValues[key] || 0)) * 100) / 100;

            objs.push(common);
        }
    }

    objs.forEach((obj) => {
        const id = obj.id;
        delete obj.id;
        const onChange = obj.onChange;
        delete obj.onChange;
        objectHelper.setOrUpdateObject(deviceId + '.' + id, {
            type: 'state',
            common: obj
        }, values[id], onChange);
    });
}

function initDevice(deviceId, deviceDef, device, callback) {
    if (!knownDevices[deviceId]) {
        knownDevices[deviceId] = {};
    }
    knownDevices[deviceId].device = device;
    knownDevices[deviceId].deviceDef = deviceDef;

    objectHelper.setOrUpdateObject(deviceId, {
        type: 'device',
        common: {
            name: deviceDef.devName || 'Device ' + deviceId
        },
        native: deviceDef
    });
    objectHelper.setOrUpdateObject(deviceId + '.online', {
        type: 'state',
        common: {
            name: 'Device online status',
            type: 'boolean',
            role: 'indicator.reachable',
            read: true,
            write: false
        }
    }, false);

    device.getSystemAbilities((err, deviceAbilities) => {
        adapter.log.debug(deviceId + ' Abilities: ' + JSON.stringify(deviceAbilities));
        if (err || !deviceAbilities) {
            adapter.log.warn('Can not get Abilities for Device ' + deviceId + ': ' + err);
            objectHelper.processObjectQueue(() => {
                callback && callback();
            });
            return;
        }
        knownDevices[deviceId].deviceAbilities = deviceAbilities;

        device.getSystemAllData((err, deviceAllData) => {
            adapter.log.debug(deviceId + ' All-Data: ' + JSON.stringify(deviceAllData));
            if (err || !deviceAllData) {
                adapter.log.warn('Can not get Data for Device ' + deviceId + ': ' + err);
                objectHelper.processObjectQueue(() => {
                    callback && callback();
                });
                return;
            }
            knownDevices[deviceId].deviceAllData = deviceAllData;

            if (!deviceAbilities.ability['Appliance.Control.ToggleX'] && !deviceAbilities.ability['Appliance.Control.Toggle']) {
                adapter.log.info('Ability Toggle/ToggleX not supported by Device ' + deviceId + ': send next line from disk to developer');
                adapter.log.info(JSON.stringify(deviceAbilities));
                objectHelper.processObjectQueue(() => {
                    callback && callback();
                });
                return;
            }

            if (deviceAllData && deviceAllData.all && deviceAllData.all.system && deviceAllData.all.system.firmware && deviceAllData.all.system.firmware.innerIp) {
                objectHelper.setOrUpdateObject(deviceId + '.ip', {
                    type: 'state',
                    common: {
                        name: 'Device IP',
                        type: 'string',
                        role: 'info.ip',
                        read: true,
                        write: false
                    }
                }, deviceAllData.all.system.firmware.innerIp);
            }

            initDeviceObjects(deviceId, deviceDef.channels, deviceAllData.all.digest || deviceAllData.all.control);

            if (deviceAbilities.ability['Appliance.Control.Electricity']) {
                device.getControlElectricity((err, res) => {
                    //{"electricity":{"channel":0,"current":0,"voltage":2331,"power":0}}
                    adapter.log.debug(deviceId + ' Electricity: ' + JSON.stringify(res));
                    initDeviceObjects(deviceId, deviceDef.channels, res);

                    objectHelper.processObjectQueue(() => {
                        callback && callback();
                    });
                });
                pollElectricity(deviceId);
            }
            else {
                objectHelper.processObjectQueue(() => {
                    callback && callback();
                });
            }
        });
    });
}

function initDone() {
    adapter.log.info('Devices initialized');
    adapter.subscribeStates('*');
}

function pollElectricity(deviceId, delay) {
    if (!knownDevices[deviceId].deviceAbilities.ability['Appliance.Control.Electricity']) return;
    if (!delay) delay = adapter.config.electricityPollingInterval || 20;
    if (knownDevices[deviceId].electricityPollTimeout) {
        clearTimeout(knownDevices[deviceId].electricityPollTimeout);
        knownDevices[deviceId].electricityPollTimeout = null;
    }
    knownDevices[deviceId].electricityPollTimeout = setTimeout(() => {
        knownDevices[deviceId].electricityPollTimeout = null;
        knownDevices[deviceId].device.getControlElectricity((err, res) => {
            if (!err) {
                //{"electricity":{"channel":0,"current":0,"voltage":2331,"power":0}}
                adapter.log.debug(deviceId + ' Electricity: ' + JSON.stringify(res));
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
            adapter.setState(deviceId + '.' + val.channel, !!val.onoff, true);
        });
        pollElectricity(deviceId, 2);
    }
}

function setValuesToggle(deviceId, payload) {
    // {"toggle":{"onoff":1,"lmTime":1542311107}}
    if (payload && payload.toggle) {
        adapter.setState(deviceId + '.0-switch', !!payload.toggle.onoff, true);
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

            adapter.setState(deviceId + '.' + channel + '-' + key, Math.floor(payload.electricity[key] * Math.pow(10, (scaleValues[key] || 0)) * 100) / 100, true);
        }
    }
}

// main function
function main() {
    setConnected(false);
    objectHelper.init(adapter);

    // Maximum password length supported by cloud is 15 characters
    if (adapter.config.password.length > 15) {
        adapter.config.password = adapter.config.password.substring(0, 15);
    }

    const options = {
        'email': adapter.config.user,
        'password': adapter.config.password,
        'logger': adapter.log.debug
    };

    meross = new MerossCloud(options);
    let connectedDevices = 0;

    let deviceCount = 0;
    meross.on('deviceInitialized', (deviceId, deviceDef, device) => {
        adapter.log.info('Device ' + deviceId + ' initialized');
        adapter.log.debug(JSON.stringify(deviceDef));

        device.on('connected', () => {
            adapter.log.info('Device: ' + deviceId + ' connected');
            initDevice(deviceId, deviceDef, device, () => {
                device.getOnlineStatus((err, res) => {
                    adapter.log.debug('Online: ' + JSON.stringify(res));
                    if (err || !res) return;
                    adapter.setState(deviceId + '.online', (res.online.status === 1), true);
                });

                if (!--deviceCount) initDone();
            });
            connectedDevices++;
            setConnected(true);
        });

        device.on('close', (error) => {
            adapter.log.info('Device: ' + deviceId + ' closed: ' + error);
            adapter.setState(deviceId + '.online', false, true);
            setConnected((--connectedDevices > 0));
            if (knownDevices[deviceId].electricityPollTimeout) {
                clearTimeout(knownDevices[deviceId].electricityPollTimeout);
                knownDevices[deviceId].electricityPollTimeout = null;
            }
        });

        device.on('error', (error) => {
            adapter.log.info('Device: ' + deviceId + ' error: ' + error);
        });

        device.on('reconnect', () => {
            adapter.log.info('Device: ' + deviceId + ' reconnected');
        });

        device.on('data', (namespace, payload) => {
            adapter.log.debug('Device: ' + deviceId + ' ' + namespace + ' - data: ' + JSON.stringify(payload));
            switch(namespace) {
                case 'Appliance.Control.ToggleX':
                    setValuesToggleX(deviceId, payload);
                    break;
                case 'Appliance.Control.Toggle':
                    setValuesToggle(deviceId, payload);
                    break;
                case 'Appliance.System.Online':
                    adapter.setState(deviceId + '.online', (payload.online.status === 1), true);
                    break;
                case 'Appliance.Control.Upgrade':
                case 'Appliance.System.Report':
                    break;

                default:
                    adapter.log.info('Received unknown data ' + namespace + ': ' + JSON.stringify(payload));
                    adapter.log.info('Please send full line from logfile on disk to developer');
            }
        });
        device.on('rawData', (message) => {
            adapter.log.debug('Device Raw: ' + deviceId + ' - data: ' + JSON.stringify(message));
        });

    });

    meross.on('data', (deviceId, namespace, payload) => {
        adapter.log.debug('Device(2): ' + deviceId + ' ' + namespace + ' - data: ' + JSON.stringify(payload));
    });

    meross.connect((error, count) => {
        if (error) {
            adapter.log.error('Meross Connection Error: ' + error);
            return;
        }
        deviceCount += count;
    });


/*
    adapter.getDevices((err, devices) => {
        let deviceCnt = 0;
        if (devices && devices.length) {
            adapter.log.debug('init ' + devices.length + ' known devices');
            devices.forEach((device) => {
                if (device._id && device.native) {
                    const id = device._id.substr(adapter.namespace.length + 1);
                    deviceCnt++;
                    initDevice(id, device.native.productKey, device.native, () => {
                        if (!--deviceCnt) initDone();
                    });
                }
            });
        }
        if (!deviceCnt) {
            initDone();
        }
    });
    */
}
