var socketIO = require('socket.io'),
    uuid = require('node-uuid'),
    crypto = require('crypto');

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

    return io;

};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () {};
    }
}
