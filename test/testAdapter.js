/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
'use strict';
const expect = require('chai').expect;
const setup  = require(__dirname + '/lib/setup');
const request = require('request');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

let objects = null;
let states  = null;
let onStateChanged = null;
let onObjectChanged = null;
let sendToID = 1;

const adapterShortName = setup.adapterName.substring(setup.adapterName.indexOf('.')+1);

let httpServer;
let lastHTTPRequest = null;
let wsServer;
let wsConnection;
let lastWSRequest = null;

function encrypt(key, value) {
    var result = '';
    for(var i = 0; i < value.length; ++i) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

function setupServer(port, callback) {

    const server = new http.createServer(function (req, res) {
        const header = req.headers.authorization || '';        // get the header
        console.log('HEADER HTTP:' + header);
        const token=header.split(/\s+/).pop() || '';            // and the encoded auth token
        const auth=new Buffer.from(token, 'base64').toString();    // convert from base64
        const parts=auth.split(/:/);                          // split on colon
        console.log(parts);
        expect(parts[0]).to.be.equal('testuser');
        expect(parts[1]).to.be.equal('e9e633097ab9ceb3e48ec3f70ee2beba41d05d5420efee5da85f97d97005727587fda33ef4ff2322088f4c79e8133cc9cd9f3512f4d3a303cbdb5bc585415a00'); //sha512('testpassword').toString('hex'));

        lastHTTPRequest = req.url;
        console.log('HTTP Received: ' + lastHTTPRequest);
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('access_token=e663e30818201d28dd07803e57333bed4f15803a&user_id=23&device_id=1&expires=360');
    });
    httpServer = server;

    wsServer = new WebSocket.Server({ server });

    wsServer.on('connection', function connection(ws) {
        wsConnection = ws;
        console.log('WS Connected ...');
        ws.on('message', function incoming(message) {
            console.log('WS received: %s', message);
            lastWSRequest = message;
            if (message === 'GET:nodes') {
                const nodes = fs.readFileSync(__dirname + "/nodes.json");
                ws.send(nodes);
                console.log('sending content of nodes.json');
            }
            else if (message === 'GET:homeegrams') {
                const homeegrams = fs.readFileSync(__dirname + "/homeegrams.json");
                ws.send(homeegrams);
                console.log('sending content of homeegrams.json');
            }
        });

        //ws.send('something');
    });

    httpServer.listen(port);

    setTimeout(function() {
        callback();
    }, 5000);
}

function checkConnectionOfAdapter(cb, counter) {
    counter = counter || 0;
    console.log('Try check #' + counter);
    if (counter > 30) {
        if (cb) cb('Cannot check connection');
        return;
    }

    states.getState('system.adapter.' + adapterShortName + '.0.alive', (err, state) => {
        if (err) console.error(err);
        if (state && state.val) {
            if (cb) cb();
        } else {
            setTimeout(function () {
                checkConnectionOfAdapter(cb, counter + 1);
            }, 1000);
        }
    });
}

function checkValueOfState(id, value, cb, counter) {
    counter = counter || 0;
    if (counter > 20) {
        if (cb) cb('Cannot check value Of State ' + id);
        return;
    }

    states.getState(id, (err, state) => {
        if (err) console.error(err);
        if (value === null && !state) {
            if (cb) cb();
        } else
        if (state && (value === undefined || state.val === value)) {
            if (cb) cb();
        } else {
            setTimeout(function () {
                checkValueOfState(id, value, cb, counter + 1);
            }, 500);
        }
    });
}

function sendTo(target, command, message, callback) {
    onStateChanged =  (id, state) => (id === 'messagebox.system.adapter.test.0') && callback(state.message);

    states.pushMessage('system.adapter.' + target, {
        command:    command,
        message:    message,
        from:       'system.adapter.test.0',
        callback: {
            message: message,
            id:      sendToID++,
            ack:     false,
            time:    Date.now()
        }
    });
}

describe('Test ' + adapterShortName + ' adapter', () => {
    before('Test ' + adapterShortName + ' adapter: Start js-controller', function (_done) {
        this.timeout(600000); // because of first install from npm

        setup.setupController(systemConfig => {
            const config = setup.getAdapterConfig();
            // enable adapter
            config.common.enabled  = true;
            config.common.loglevel = 'debug';

            config.native.host = '127.0.0.1';
            config.native.user = 'testuser';
            config.native.password = encrypt(systemConfig.native.secret, 'testpassword');

            setup.setAdapterConfig(config.common, config.native);

            setupServer(7681, () => {
                setup.startController(true,
                    (id, obj) => {},
                    (id, state) => onStateChanged && onStateChanged(id, state),
                    (_objects, _states) => {
                        objects = _objects;
                        states  = _states;
                        _done();
                    });
            });
        });
    });

/*
    ENABLE THIS WHEN ADAPTER RUNS IN DEAMON MODE TO CHECK THAT IT HAS STARTED SUCCESSFULLY
*/
    it('Test ' + adapterShortName + ' adapter: Check if adapter started', done => {
        checkConnectionOfAdapter(res => {
            if (res) console.log(res);
            expect(res).not.to.be.equal('Cannot check connection');
            objects.setObject('system.adapter.test.0', {
                    common: {

                    },
                    type: 'instance'
                },
                () => {
                    states.subscribeMessage('system.adapter.test.0');
                    done();
                });
        });
    }).timeout(60000);

    it('Test ' + adapterShortName + ' Wrapper adapter: Wait for init', done => {
        setTimeout(() => done(), 20000);
    }).timeout(60000);

    it('Test ' + adapterShortName + ' Wrapper: Verify Init', done => {
        states.getState(adapterShortName + '.0.OpenCloseWithTemperatureAndBrightnessSensor-15.FirmwareRevision-63', (err, state) => {
            expect(err).to.not.exist;
            expect(state.val).to.be.equal('3.95');

            states.getState(adapterShortName + '.0.OpenCloseWithTemperatureAndBrightnessSensor-15.WakeUpInterval-66', (err, state) => {
                expect(err).to.not.exist;
                expect(state.val).to.be.equal(1440);

                done();
            });
        });
    });

    it('Test ' + adapterShortName + ': Test Change from homee non-ack', done => {
        const data = {
            "attribute": {
                "id": 66,
                "state": 1,
                "node_id": 15,
                "instance": 1,
                "minimum": 0.0,
                "maximum": 100.0,
                "current_value": 10.9,
                "target_value": 50.5,
                "last_value": 50.0,
                "data": "",
                "unit": "%25",
                "step_value": 0.5,
                "editable": 1,
                "type": 4,
                "last_changed": 10153,
                "changed_by": 1,
                "changed_by_id": 0,
                "based_on": 1,
                "options": []
            }
        };
        wsConnection.send(JSON.stringify(data));
        setTimeout(function() {
            states.getState(adapterShortName + '.0.OpenCloseWithTemperatureAndBrightnessSensor-15.WakeUpInterval-66', (err, state) => {
                expect(err).to.not.exist;
                expect(state.val).to.be.equal(1440);

                done();
            });
        }, 1000);
    }).timeout(10000);

    it('Test ' + adapterShortName + ': Test Change from homee', done => {
        const data = {
            "attribute": {
                "id": 66,
                "state": 1,
                "node_id": 15,
                "instance": 1,
                "minimum": 0.0,
                "maximum": 100.0,
                "current_value": 50.5,
                "target_value": 50.5,
                "last_value": 50.0,
                "data": "",
                "unit": "%25",
                "step_value": 0.5,
                "editable": 1,
                "type": 4,
                "last_changed": 10153,
                "changed_by": 1,
                "changed_by_id": 0,
                "based_on": 1,
                "options": []
            }
        };
        wsConnection.send(JSON.stringify(data));
        setTimeout(function() {
            states.getState(adapterShortName + '.0.OpenCloseWithTemperatureAndBrightnessSensor-15.WakeUpInterval-66', (err, state) => {
                expect(err).to.not.exist;
                expect(state.val).to.be.equal(50.5);

                done();
            });
        }, 1000);

    }).timeout(10000);

    it('Test ' + adapterShortName + ': Test change via iobroker', done => {
        states.setState(adapterShortName + '.0.OpenCloseWithTemperatureAndBrightnessSensor-15.WakeUpInterval-66', {val: 77.7, ack: false}, err => {
            expect(err).to.not.exist;

            setTimeout(function() {
                expect(lastWSRequest).to.be.equal('PUT:/nodes/15/attributes/66?target_value=77.7');
                done();
            }, 1000);
        });
    }).timeout(10000);

    it('Test ' + adapterShortName + ': Test homeegram trigger via iobroker', done => {
        states.setState(adapterShortName + '.0.Homee-0.Homeegrams.1.play', {val: true, ack: false}, err => {
            expect(err).to.not.exist;

            setTimeout(function() {
                expect(lastWSRequest).to.be.equal('PUT:homeegrams/1?play=1');
                done();
            }, 1000);
        });
    }).timeout(10000);

    after('Test ' + adapterShortName + ' adapter: Stop js-controller', function (done) {
        this.timeout(10000);

        setup.stopController(function (normalTerminated) {
            console.log('Adapter normal terminated: ' + normalTerminated);
            httpServer.close();
            done();
        });
    });
});
