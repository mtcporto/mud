const net = require('net');
const EventEmitter = require('events');

// Cache de conexões ativas
const connections = new Map();
let connectionCounter = 0;

class MudConnection extends EventEmitter {
    constructor(host, port) {
        super();
        this.host = host;
        this.port = port;
        this.socket = null;
        this.isConnected = false;
        this.buffer = '';
        this.lastActivity = Date.now();
        this.id = `mud_${++connectionCounter}_${Date.now()}`;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.socket = new net.Socket();
            
            this.socket.setTimeout(30000); // 30 segundos timeout
            
            this.socket.connect(this.port, this.host, () => {
                this.isConnected = true;
                this.lastActivity = Date.now();
                console.log(`Conectado ao MUD: ${this.host}:${this.port}`);
                resolve();
            });

            this.socket.on('data', (data) => {
                const text = data.toString('utf8');
                this.buffer += text;
                this.lastActivity = Date.now();
                this.emit('data', text);
            });

            this.socket.on('error', (error) => {
                console.error('Erro de socket:', error);
                this.isConnected = false;
                this.emit('error', error);
                reject(error);
            });

            this.socket.on('close', () => {
                console.log('Conexão fechada');
                this.isConnected = false;
                this.emit('close');
            });

            this.socket.on('timeout', () => {
                console.log('Timeout de conexão');
                this.socket.destroy();
                this.isConnected = false;
                this.emit('timeout');
            });
        });
    }

    send(command) {
        if (this.isConnected && this.socket) {
            this.socket.write(command + '\n');
            this.lastActivity = Date.now();
            return true;
        }
        return false;
    }

    disconnect() {
        this.isConnected = false;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.removeAllListeners();
    }

    isActive() {
        return this.isConnected && (Date.now() - this.lastActivity < 300000); // 5 minutos
    }
}

// Limpeza automática de conexões inativas
setInterval(() => {
    for (const [id, connection] of connections.entries()) {
        if (!connection.isActive()) {
            console.log(`Removendo conexão inativa: ${id}`);
            connection.disconnect();
            connections.delete(id);
        }
    }
}, 60000); // A cada minuto

export default async function handler(req, res) {
    // Configurar CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const { action, host, port, connectionId, command } = req.method === 'GET' ? req.query : req.body;

    try {
        switch (action) {
            case 'connect':
                return await handleConnect(req, res, host, parseInt(port));
            
            case 'send':
                return await handleSend(req, res, connectionId, command);
            
            case 'disconnect':
                return await handleDisconnect(req, res, connectionId);
            
            case 'stream':
                return await handleStream(req, res, connectionId);
            
            case 'status':
                return handleStatus(req, res);
            
            default:
                res.status(400).json({ 
                    success: false, 
                    error: 'Ação inválida. Use: connect, send, disconnect, stream, status' 
                });
        }
    } catch (error) {
        console.error('Erro na API:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
}

async function handleConnect(req, res, host, port) {
    if (!host || !port) {
        return res.status(400).json({
            success: false,
            error: 'Host e porta são obrigatórios'
        });
    }

    try {
        const connection = new MudConnection(host, port);
        await connection.connect();
        
        connections.set(connection.id, connection);
        
        console.log(`Nova conexão criada: ${connection.id} para ${host}:${port}`);
        
        res.json({
            success: true,
            connectionId: connection.id,
            message: `Conectado ao MUD ${host}:${port}`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

async function handleSend(req, res, connectionId, command) {
    if (!connectionId || command === undefined) {
        return res.status(400).json({
            success: false,
            error: 'connectionId e command são obrigatórios'
        });
    }

    const connection = connections.get(connectionId);
    if (!connection) {
        return res.status(404).json({
            success: false,
            error: 'Conexão não encontrada'
        });
    }

    if (!connection.isConnected) {
        return res.status(400).json({
            success: false,
            error: 'Conexão não está ativa'
        });
    }

    const sent = connection.send(command);
    
    res.json({
        success: sent,
        message: sent ? 'Comando enviado' : 'Falha ao enviar comando'
    });
}

async function handleDisconnect(req, res, connectionId) {
    if (!connectionId) {
        return res.status(400).json({
            success: false,
            error: 'connectionId é obrigatório'
        });
    }

    const connection = connections.get(connectionId);
    if (connection) {
        connection.disconnect();
        connections.delete(connectionId);
        console.log(`Conexão desconectada: ${connectionId}`);
    }

    res.json({
        success: true,
        message: 'Desconectado'
    });
}

async function handleStream(req, res, connectionId) {
    if (!connectionId) {
        return res.status(400).json({
            success: false,
            error: 'connectionId é obrigatório'
        });
    }

    const connection = connections.get(connectionId);
    if (!connection) {
        return res.status(404).json({
            success: false,
            error: 'Conexão não encontrada'
        });
    }

    // Configurar Server-Sent Events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    // Enviar dados iniciais
    res.write('data: ' + JSON.stringify({
        type: 'connected',
        message: 'Stream iniciado'
    }) + '\n\n');

    // Listener para dados do MUD
    const dataListener = (data) => {
        res.write('data: ' + JSON.stringify({
            type: 'mud_output',
            content: data,
            timestamp: Date.now()
        }) + '\n\n');
    };

    // Listener para erros
    const errorListener = (error) => {
        res.write('data: ' + JSON.stringify({
            type: 'error',
            message: error.message
        }) + '\n\n');
    };

    // Listener para desconexão
    const closeListener = () => {
        res.write('data: ' + JSON.stringify({
            type: 'disconnect',
            message: 'Conexão encerrada'
        }) + '\n\n');
        res.end();
    };

    // Adicionar listeners
    connection.on('data', dataListener);
    connection.on('error', errorListener);
    connection.on('close', closeListener);

    // Ping periódico para manter conexão
    const pingInterval = setInterval(() => {
        if (!connection.isConnected) {
            clearInterval(pingInterval);
            return;
        }
        
        res.write('data: ' + JSON.stringify({
            type: 'ping',
            timestamp: Date.now()
        }) + '\n\n');
    }, 30000); // A cada 30 segundos

    // Limpar listeners quando cliente desconectar
    req.on('close', () => {
        connection.off('data', dataListener);
        connection.off('error', errorListener);
        connection.off('close', closeListener);
        clearInterval(pingInterval);
        console.log(`Cliente desconectado do stream: ${connectionId}`);
    });
}

function handleStatus(req, res) {
    const activeConnections = Array.from(connections.entries()).map(([id, conn]) => ({
        id,
        host: conn.host,
        port: conn.port,
        connected: conn.isConnected,
        lastActivity: conn.lastActivity
    }));

    res.json({
        success: true,
        totalConnections: connections.size,
        connections: activeConnections
    });
}