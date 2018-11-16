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
let connectedCount = 0;

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

function initDeviceObjects(deviceId, channels, digest) {
    const objs = [];
    const values = {};

    if (digest.toggle) {
        const val = digest.toggle;
        const common = {};
        if (val.onoff !== undefined) {
            common.type = 'boolean';
            common.read = true;
            common.write = true;
            common.name = 'Switch';
            common.role = defineRole(common);
            common.id = 'switch';
            values['switch'] = !!val.onoff;
        }
        else {
            adapter.log.info('Unsupported type for digest val ' + JSON.stringify(val));
            return;
        }
        objs.push(common);
    }
    else if (digest.togglex) {
        if (!Array.isArray(digest.togglex)) {
            digest.togglex = [digest.togglex];
        }
        digest.togglex.forEach((val) => {
            const common = {};
            if (val.onoff !== undefined) {
                common.type = 'boolean';
                common.read = true;
                common.write = true;
                common.name = '';
                if (channels[val.channel] && channels[val.channel].devName) {
                    common.name = channels[val.channel].devName;
                }
                if (!common.name.length && val.channel == '0') {
                    common.name = 'All';
                }
                common.role = defineRole(common);
                common.id = val.channel;
                values[val.channel] = !!val.onoff;
            }
            else {
                adapter.log.info('Unsupported type for digest val ' + JSON.stringify(val));
                return;
            }
            objs.push(common);
        });
    }

    objs.forEach((obj) => {
        const id = obj.id;
        delete obj.id;
        let onChange;
        if (obj.write) {
            onChange = (value) => {
                if (!knownDevices[deviceId].device) {
                    adapter.log.debug(deviceId + 'Device communication not initialized ...');
                    return;
                }

                knownDevices[deviceId].device.controlToggleX(id, (value ? 1 : 0), (err, res) => {
                    adapter.log.debug('Toggle Response: err: ' + err + ', res: ' + JSON.stringify(res));
                    adapter.log.debug(deviceId + '.' + id + ': set value ' + value);
                });
            };
        }
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

            initDeviceObjects(deviceId, deviceDef.channels, deviceAllData.all.digest);

            objectHelper.processObjectQueue(() => {
                callback && callback();
            });

            if (deviceAbilities.ability['Appliance.Control.Electricity']) {
                device.getControlElectricity((err, res) => {
                    adapter.log.info(deviceId + ' Electricity: ' + JSON.stringify(res));

                    if (deviceAbilities.ability['Appliance.Control.ConsumptionX']) {
                        device.getControlPowerConsumptionX((err, res) => {
                            adapter.log.info(deviceId + ' ConsumptionX: ' + JSON.stringify(res));

                            if (deviceAbilities.ability['Appliance.Control.Consumption']) {
                                device.getControlPowerConsumption((err, res) => {
                                    adapter.log.info(deviceId + ' Consumption: ' + JSON.stringify(res));
                                });
                            }
                        });
                    }
                });
            }
        });
    });
}

function initDone() {
    adapter.log.info('Devices initialized');
    adapter.subscribeStates('*');
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
    }
}

function setValuesToggle(deviceId, payload) {
    // {"toggle":{"onoff":1,"lmTime":1542311107}}
    if (payload && payload.toggle) {
        adapter.setState(deviceId + '.switch', !!payload.toggle.onoff, true);
    }
}

// main function
function main() {
    setConnected(false);
    objectHelper.init(adapter);

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
        let connectionCount = 0;

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
