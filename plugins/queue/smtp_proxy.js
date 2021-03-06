// Forward to an SMTP server as a proxy.
// Opens the connection to the ongoing SMTP server at MAIL FROM time
// and passes back any errors seen on the ongoing server to the originating server.

var os   = require('os');
var sock = require('./line_socket');

var smtp_regexp = /^([0-9]{3})([ -])(.*)/;

// Local function to get an smtp_proxy connection.
// This function will either choose one from the pool or make new one.
function _get_smtp_proxy(self, next, connection) {
    var smtp_proxy = {};

    if (connection.server.notes.smtp_proxy_pool &&
        connection.server.notes.smtp_proxy_pool.length) {
        self.logdebug("using connection from the pool: (" +
            connection.server.notes.smtp_proxy_pool.length + ")");

        smtp_proxy = connection.server.notes.smtp_proxy_pool.shift();

        // We should just reset these things when we shift a connection off
        // since we have to setup stuff based on _this_ connection.
        smtp_proxy.response = [];
        smtp_proxy.recipient_marker = 0;
        smtp_proxy.pool_connection = 1;
        connection.notes.smtp_proxy = smtp_proxy;
        smtp_proxy.next = next;

        // Cleanup all old event listeners
        // Note, if new ones are added in the mail from handler,
        // please remove them here.
        smtp_proxy.socket.removeAllListeners('error');
        smtp_proxy.socket.removeAllListeners('timeout');
        smtp_proxy.socket.removeAllListeners('close');
        smtp_proxy.socket.removeAllListeners('connect');
        smtp_proxy.socket.removeAllListeners('line');
        smtp_proxy.socket.removeAllListeners('drain');
    } else {
        smtp_proxy.config = self.config.get('smtp_proxy.ini', 'ini');
        smtp_proxy.socket = new sock.Socket();
        smtp_proxy.socket.connect(smtp_proxy.config.main.port,
            smtp_proxy.config.main.host);
        smtp_proxy.socket.setTimeout((smtp_proxy.config.main.timeout) ?
            (smtp_proxy.config.main.timeout * 1000) : (300 * 1000));
        smtp_proxy.command = 'connect';
        smtp_proxy.response = [];
        smtp_proxy.recipient_marker = 0;
        smtp_proxy.pool_connection = 0;
        connection.notes.smtp_proxy = smtp_proxy;
        smtp_proxy.next = next;
    }

    if (connection.server.notes.active_proxy_conections >= 0) {
        connection.server.notes.active_proxy_conections++;
    } else {
        connection.server.notes.active_proxy_conections = 1;
    }

    self.logdebug("active proxy connections: (" +
        connection.server.notes.active_proxy_conections + ")");

    return smtp_proxy;
}

// function will destroy an smtp_proxy and pull it out of the idle array
function _destroy_smtp_proxy(self, connection, smtp_proxy) {
    var reset_active_connections = 0;
    var index;

    if (smtp_proxy && smtp_proxy.socket) {
        self.logdebug("destroying proxy connection");
        smtp_proxy.socket.destroySoon();
        smtp_proxy.socket = 0;
        reset_active_connections = 1;
    }

    // Unlink the connection from the proxy just in case we got here
    // without that happening already.
    if (connection && connection.notes.smtp_proxy) {
        delete connection.notes.smtp_proxy;
    }

    if (connection.server.notes.smtp_proxy_pool) {
        // Pull that smtp_proxy from the proxy pool.
        // Note we do not do this operation that often.
        index = connection.server.notes.smtp_proxy_pool.indexOf(smtp_proxy);
        if (index != -1) {
            connection.server.notes.smtp_proxy_pool.splice(index, 1);
            self.logdebug("pulling dead proxy connection from pool: (" +
                connection.server.notes.smtp_proxy_pool.length + ")");
        }
    }

    if (reset_active_connections) {
        connection.server.notes.active_proxy_conections--;
        self.logdebug("active proxy connections: (" +
            connection.server.notes.active_proxy_conections + ")");
    }

    return;
}

function _smtp_proxy_idle(self, connection) {
    var smtp_proxy = connection.notes.smtp_proxy;

    if (!(smtp_proxy)) {
        return;
    }

    if (connection.server.notes.smtp_proxy_pool) {
        connection.server.notes.smtp_proxy_pool.push(smtp_proxy);
    } else {
        connection.server.notes.smtp_proxy_pool = [ smtp_proxy ];
    }

    connection.server.notes.active_proxy_conections--;

    self.logdebug("putting proxy connection back in pool: (" +
        connection.server.notes.smtp_proxy_pool.length + ")");
    self.logdebug("active proxy connections: (" +
        connection.server.notes.active_proxy_conections + ")");

    // Unlink this connection from the proxy now that it is back
    // in the pool.
    if (connection && connection.notes.smtp_proxy) {
        delete connection.notes.smtp_proxy;
    }

    return;
}

exports.hook_mail = function (next, connection, params) {
    this.loginfo("smtp proxying");
    var self = this;
    var mail_from = params[0];
    var data_marker = 0;
    var smtp_proxy = _get_smtp_proxy(self, next, connection);

    smtp_proxy.send_data = function () {
        if (data_marker < connection.transaction.data_lines.length) {
            var wrote_all = smtp_proxy.socket.write(connection.transaction.data_lines[data_marker].replace(/^\./, '..').replace(/\r?\n/g, '\r\n'));
            data_marker++;
            if (wrote_all) {
                smtp_proxy.send_data();
            }
        }
        else {
            smtp_proxy.socket.send_command('dot');
        }
    }

    // Add socket event listeners.    
    // Note, if new ones are added here, please remove them in _get_smtp_proxy.

    smtp_proxy.socket.on('error', function (err) {
        self.logdebug("Ongoing connection failed: " + err);
        _destroy_smtp_proxy(self, connection, smtp_proxy);
    });

    smtp_proxy.socket.on('timeout', function () {
        self.logdebug("Ongoing connection timed out");
        _destroy_smtp_proxy(self, connection, smtp_proxy);
    });
    
    smtp_proxy.socket.on('close', function (had_error) {
        self.logdebug("Ongoing connection closed");
        _destroy_smtp_proxy(self, connection, smtp_proxy);
    });

    smtp_proxy.socket.on('connect', function () {});
    
    smtp_proxy.socket.send_command = function (cmd, data) {
        var line = cmd + (data ? (' ' + data) : '');
        if (cmd === 'dot') {
            line = '.';
        }
        self.logprotocol("Proxy C: " + line);
        this.write(line + "\r\n");
        smtp_proxy.command = cmd.toLowerCase();
    };
    
    smtp_proxy.socket.on('line', function (line) {
        var matches;
        self.logprotocol("Proxy S: " + line);
        if (matches = smtp_regexp.exec(line)) {
            var code = matches[1],
                cont = matches[2],
                rest = matches[3];
            smtp_proxy.response.push(rest);
            if (cont === ' ') {
                if (code.match(/^[45]/)) {
                    if (smtp_proxy.command !== 'rcpt') {
                        // errors are OK for rcpt, but nothing else
                        // this can also happen if the destination server
                        // times out, but that is okay.
                        smtp_proxy.socket.send_command('RSET');
                    }
                    return smtp_proxy.next(code.match(/^4/) ?
                        DENYSOFT : DENY, smtp_proxy.response);
                }

                smtp_proxy.response = []; // reset the response

                switch (smtp_proxy.command) {
                    case 'connect':
                        smtp_proxy.socket.send_command('HELO',
                            self.config.get('me'));
                        break;
                    case 'helo':
                        smtp_proxy.socket.send_command('MAIL',
                            'FROM:' + mail_from);
                        break;
                    case 'mail':
                        smtp_proxy.next();
                        break;
                    case 'rcpt':
                        smtp_proxy.next();
                        break;
                    case 'data':
                        smtp_proxy.next();
                        break;
                    case 'dot':
                        smtp_proxy.socket.send_command('RSET');
                        smtp_proxy.next(OK);
                        break;
                    case 'rset':
                        _smtp_proxy_idle(self, connection);
                        // We do not call next() here because many paths
                        // lead to this conclusion, and next() is called
                        // on a case-by-case basis.
                        break;
                    default:
                        throw "Unknown command: " + smtp_proxy.command;
                }
            }
        }
        else {
            // Unrecognised response.
            self.logerror("Unrecognised response from upstream server: " + line);
            smtp_proxy.socket.send_command('RSET');
            return smtp_proxy.next(DENYSOFT);
        }
    });

    smtp_proxy.socket.on('drain', function() {
        self.logprotocol("Drained");
        if (smtp_proxy.command === 'dot') {
            smtp_proxy.send_data();
        }
    });

    if (smtp_proxy.pool_connection) {
        smtp_proxy.socket.send_command('MAIL', 'FROM:' + mail_from);
    }
};

exports.hook_rcpt_ok = function (next, connection, recipient) {
    if (!connection.notes.smtp_proxy) return next();
    var smtp_proxy = connection.notes.smtp_proxy;
    smtp_proxy.next = next;
    smtp_proxy.socket.send_command('RCPT', 'TO:' + recipient);
};

exports.hook_data = function (next, connection) {
    if (!connection.notes.smtp_proxy) return next();
    var smtp_proxy = connection.notes.smtp_proxy;
    smtp_proxy.next = next;
    smtp_proxy.socket.send_command("DATA");
};

exports.hook_queue = function (next, connection) {
    if (!connection.notes.smtp_proxy) return next();
    var smtp_proxy = connection.notes.smtp_proxy;
    smtp_proxy.command = 'dot';
    smtp_proxy.next = next;
    smtp_proxy.send_data();
};

exports.hook_quit = function (next, connection) {
    if (!connection.notes.smtp_proxy) return next();
    var smtp_proxy = connection.notes.smtp_proxy;
    smtp_proxy.next = next;
    smtp_proxy.socket.send_command("RSET");
    smtp_proxy.next(OK);
};
