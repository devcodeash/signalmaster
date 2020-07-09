var socketIO = require('socket.io'),
    uuid = require('node-uuid'),
    crypto = require('crypto'),
    sdptransform = require('sdp-transform');

module.exports = function (server, config, hooks) {
    var io = socketIO.listen(server);

    io.sockets.on('connection', function (client) {
        client.resources = {
            screen: false,
            video: true,
            audio: false
        };
        client.extras = {};

        // pass a message to another id
        client.on('message', function (details) {
            if (!details) return;

            var otherClient = io.to(details.to);
            if (!otherClient) return;

            details.from = client.id;
            try {
                details = prioritizeVideoCodecs(details);
                details = setOpusMaxAvgBitrate(details);
            } catch (err) {
                console.error(err);
            }
            otherClient.emit('message', details);
        });

        client.on('shareScreen', function () {
            client.resources.screen = true;
        });

        client.on('unshareScreen', function (type) {
            client.resources.screen = false;
            removeFeed('screen');
        });

        client.on('join', join);

        client.on('getRoomParticipants', function (roomName, cb) {
            safeCb(cb)(null, describeRoom(roomName));
        });

        client.on('roomStatusUpdate', function (roomName, userId) {
            if (hooks && hooks.socketUpdate) {
                hooks.socketUpdate({
                    roomName: client.room || roomName,
                    userId: client.extras && client.extras.userId || userId, 
                    socketId: client.id
                });
            }
        });

        function removeFeed(type) {
            if (client.room) {
                io.sockets.in(client.room).emit('remove', {
                    id: client.id,
                    type: type
                });
                if (!type) {
                    client.leave(client.room);
                    client.room = undefined;
                }
            }
        }

        function join(name, extras, cb) {
            // sanity check
            if (typeof name !== 'string') return;
            // check if maximum number of clients reached
            if (config.rooms && config.rooms.maxClients > 0 &&
                clientsInRoom(name) >= config.rooms.maxClients) {
                safeCb(cb)('full');
                return;
            }
            // leave any existing rooms
            removeFeed();
            safeCb(cb)(null, describeRoom(name));
            client.join(name);
            client.room = name;
            client.extras = extras || {};

            if (hooks && hooks.joinedRoom) {
                hooks.joinedRoom({
                    roomName: name, 
                    userId: extras && extras.userId, 
                    socketId: client.id
                });
            }
        }

        // we don't want to pass "leave" directly because the
        // event type string of "socket end" gets passed too.
        client.on('disconnect', function () {
            removeFeed();

            if (hooks && hooks.disconnected) {
                hooks.disconnected(client.id);
            }
        });

        client.on('leave', function () {
            removeFeed();

            if (hooks && hooks.leftRoom) {
                hooks.leftRoom(client.id);
            }
        });

        client.on('create', function (name, cb) {
            if (arguments.length == 2) {
                cb = (typeof cb == 'function') ? cb : function () {};
                name = name || uuid();
            } else {
                cb = name;
                name = uuid();
            }
            // check if exists
            var room = io.nsps['/'].adapter.rooms[name];
            if (room && room.length) {
                safeCb(cb)('taken');
            } else {
                join(name);
                safeCb(cb)(null, name);
            }
        });

        // support for logging full webrtc traces to stdout
        // useful for large-scale error monitoring
        client.on('trace', function (data) {
            console.log('trace', JSON.stringify(
            [data.type, data.session, data.prefix, data.peer, data.time, data.value]
            ));
        });


        // tell client about stun and turn servers and generate nonces
        client.emit('stunservers', config.stunservers || []);

        // // create shared secret nonces for TURN authentication
        // // the process is described in draft-uberti-behave-turn-rest
        // var credentials = [];
        // // allow selectively vending turn credentials based on origin.
        // var origin = client.handshake.headers.origin;
        // if (!config.turnorigins || config.turnorigins.indexOf(origin) !== -1) {
        //     config.turnservers.forEach(function (server) {
        //         var hmac = crypto.createHmac('sha1', server.secret);
        //         // default to 86400 seconds timeout unless specified
        //         var username = Math.floor(new Date().getTime() / 1000) + (parseInt(server.expiry || 86400, 10)) + "";
        //         hmac.update(username);
        //         credentials.push({
        //             username: username,
        //             credential: hmac.digest('base64'),
        //             urls: server.urls || server.url
        //         });
        //     });
        // }
        // client.emit('turnservers', credentials);
        client.emit('turnservers', config.turnservers || []);
    });


    function describeRoom(name) {
        var adapter = io.nsps['/'].adapter;
        var clients = adapter.rooms[name] ? adapter.rooms[name].sockets : {};
        var result = {
            clients: {}
        };
        Object.keys(clients).forEach(function (id) {
            result.clients[id] = adapter.nsp.connected[id].resources;
            result.clients[id].extras = adapter.nsp.connected[id].extras || {};
        });
        return result;
    }

    function clientsInRoom(name) {
        var count = io.sockets.adapter.rooms[name] ? io.sockets.adapter.rooms[name].length : 0;

        console.log('clients in room', name, count);
        return count;
    }

    function prioritizeVideoCodecs(details) {
        var priority = config.codecPriority || ["H264", "VP8", "VP9"];  // ordered priority list, first = highest priority
        var ids = [];
        Object.keys(priority).forEach(function (key) {
            var id = findCodecId(details, priority[key]);
            if (id) {
                ids.push(id);
            }
        });
        if (ids.length > 0 && details.payload && details.payload.sdp) {
            var sdp = details.payload.sdp;
            var m = sdp.match(/m=video\s(\d+)\s[A-Z\/]+\s([0-9\ ]+)/);
            if (m !== null && m.length == 3) {
                var candidates = m[2].split(" ");
                var prioritized = ids;
                Object.keys(candidates).forEach(function (key) {
                    if (ids.indexOf(candidates[key]) == -1) {
                        prioritized.push(candidates[key]);
                    }
                });
                var mPrioritized = m[0].replace(m[2], prioritized.join(" "));
                console.log("Setting video codec priority. \"%s\"", mPrioritized);
                details.payload.sdp = sdp.replace(m[0], mPrioritized);
            }
        }
        return details;
    }

    function setOpusMaxAvgBitrate(details) {
        var maxAvgBitRate = config.maxAverageBitRate || 0;
        if (maxAvgBitRate > 0) {
            var id = findCodecId(details, "opus");
            if (id && details.payload && details.payload.sdp) {
                details.payload.sdp = alterFmtpConfig(details.payload.sdp, id, {"maxaveragebitrate": maxAvgBitRate});
            }
        }
        return details;
    }

    function alterFmtpConfig(sdp, id, params) {
        if (sdp.length > 0 && id && Object.keys(params).length > 0) {
            var res = sdptransform.parse(sdp);
            res.media.forEach(function (item) {
                item.fmtp.some(function (fmtp) {
                    if (fmtp.payload == id) {
                        var origParams = sdptransform.parseParams(fmtp.config);
                        Object.keys(params).forEach(function (key) {
                            origParams[key] = params[key];
                        });
                        fmtp.config = writeParams(origParams);
                        console.log("FMTP for payload " + id + " set to: " + fmtp.config);
                        return true; // break loop
                    } else {
                        return false; // continue loop
                    }
                });
            });
            sdp = sdptransform.write(res);
        }
        return sdp;
    }

    function writeParams(config) {
        var params = [];
        Object.keys(config).forEach(function (key) {
            params.push(key + "=" + config[key]);
        });
        return params.join(";");
    }

    function findCodecId(details, codec) {
        if (details.payload && details.payload.sdp) {
            var pattern = "a=rtpmap\\:(\\d+)\\s" + codec + "\\/\\d+";
            var re = new RegExp(pattern);
            var m = details.payload.sdp.match(re);
            if (m !== null && m.length > 0) {
                return m[1];
            }
        }
        return null;
    }

    return io;

};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () {};
    }
}
