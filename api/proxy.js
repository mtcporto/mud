const net = require('net');
const EventEmitter = require('events');

// Cache otimizado de conexões
const connections = new Map();
let connectionCounter = 0;

class OptimizedMudConnection extends EventEmitter {
    constructor(host, port) {
        super();
        this.host = host;
        this.port = port;
        this.socket = null;
        this.isConnected = false;
        this.buffer = '';
        this.lastActivity = Date.now();
        this.id = `mud_${++connectionCounter}_${Date.now()}`;
        this.heartbeatInterval = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            // Configurações otimizadas para estabilidade
            this.socket = new net.Socket();
            this.socket.setTimeout(20000); // 20 segundos timeout
            this.socket.setKeepAlive(true, 30000); // Keep-alive a cada 30s
            this.socket.setNoDelay(true); // Desabilitar delay de Nagle
            
            this.socket.connect(this.port, this.host, () => {
                this.isConnected = true;
                this.lastActivity = Date.now();
                this.startHeartbeat();
                console.log(`✅ Conectado ao MUD: ${this.host}:${this.port} [${this.id}]`);
                resolve();
            });

            this.socket.on('data', (data) => {
                try {
                    const text = data.toString('utf8');
                    this.buffer += text;
                    this.lastActivity = Date.now();
                    this.emit('data', text);
                } catch (error) {
                    console.error('Erro ao processar dados:', error);
                }
            });

            this.socket.on('error', (error) => {
                console.error(`❌ Erro de socket [${this.id}]:`, error.message);
                this.isConnected = false;
                this.stopHeartbeat();
                this.emit('error', error);
                reject(error);
            });

            this.socket.on('close', () => {
                console.log(`🔌 Conexão fechada [${this.id}]`);
                this.isConnected = false;
                this.stopHeartbeat();
                this.emit('close');
            });

            this.socket.on('timeout', () => {
                console.log(`⏰ Timeout de conexão [${this.id}]`);
                this.socket.destroy();
                this.isConnected = false;
                this.stopHeartbeat();
                this.emit('timeout');
            });
        });
    }

    startHeartbeat() {
        this.stopHeartbeat();
        
        // Heartbeat a cada 30 segundos
        this.heartbeatInterval = setInterval(() => {
            if (this.isConnected && this.socket) {
                try {
                    // Enviar dados keep-alive
                    this.socket.write('\n');
                } catch (error) {
                    console.error(`💓 Erro no heartbeat [${this.id}]:`, error);
                    this.disconnect();
                }
            }
        }, 30000);
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    send(command) {
        if (this.isConnected && this.socket && !this.socket.destroyed) {
            try {
                this.socket.write(command + '\n');
                this.lastActivity = Date.now();
                return true;
            } catch (error) {
                console.error(`📤 Erro ao enviar comando [${this.id}]:`, error);
                this.disconnect();
                return false;
            }
        }
        return false;
    }

    disconnect() {
        this.isConnected = false;
        this.stopHeartbeat();
        
        if (this.socket && !this.socket.destroyed) {
            this.socket.destroy();
        }
        this.socket = null;
        this.removeAllListeners();
    }

    isActive() {
        return this.isConnected && (Date.now() - this.lastActivity < 180000); // 3 minutos
    }
}

// Limpeza automática mais agressiva
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, connection] of connections.entries()) {
        if (!connection.isActive() || (now - connection.lastActivity > 300000)) { // 5 minutos
            console.log(`🧹 Removendo conexão inativa: ${id}`);
            connection.disconnect();
            connections.delete(id);
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        console.log(`🧹 Limpeza concluída: ${cleaned} conexões removidas, ${connections.size} ativas`);
    }
}, 30000); // A cada 30 segundos

export default async function handler(req, res) {
    // Headers CORS otimizados
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

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
        console.error('❌ Erro na API:', error);
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
        console.log(`🔄 Tentativa de conexão: ${host}:${port}`);
        const connection = new OptimizedMudConnection(host, port);
        await connection.connect();
        
        connections.set(connection.id, connection);
        
        console.log(`✅ Nova conexão criada: ${connection.id} (${connections.size} total)`);
        
        res.json({
            success: true,
            connectionId: connection.id,
            message: `Conectado ao MUD ${host}:${port}`,
            totalConnections: connections.size
        });
    } catch (error) {
        console.error(`❌ Falha na conexão ${host}:${port}:`, error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

async function handleSend(req, res, connectionId, command) {
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
            error: 'Conexão não encontrada ou expirou'
        });
    }

    if (!connection.isConnected) {
        return res.status(400).json({
            success: false,
            error: 'Conexão não está ativa'
        });
    }

    const sent = connection.send(command || '');
    
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
        console.log(`🔌 Conexão desconectada: ${connectionId} (${connections.size} restantes)`);
    }

    res.json({
        success: true,
        message: 'Desconectado',
        totalConnections: connections.size
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

    // Headers SSE otimizados
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no' // Desabilitar buffering no Nginx
    });

    // Heartbeat inicial
    res.write('data: ' + JSON.stringify({
        type: 'connected',
        message: 'Stream iniciado',
        timestamp: Date.now()
    }) + '\n\n');

    // Listeners otimizados
    const dataListener = (data) => {
        try {
            res.write('data: ' + JSON.stringify({
                type: 'mud_output',
                content: data,
                timestamp: Date.now()
            }) + '\n\n');
        } catch (error) {
            console.error('Erro ao enviar dados SSE:', error);
        }
    };

    const errorListener = (error) => {
        try {
            res.write('data: ' + JSON.stringify({
                type: 'error',
                message: error.message,
                timestamp: Date.now()
            }) + '\n\n');
        } catch (err) {
            console.error('Erro ao enviar erro SSE:', err);
        }
    };

    const closeListener = () => {
        try {
            res.write('data: ' + JSON.stringify({
                type: 'disconnect',
                message: 'Conexão encerrada',
                timestamp: Date.now()
            }) + '\n\n');
        } catch (error) {
            console.error('Erro ao enviar close SSE:', error);
        }
        
        // Pequeno delay antes de fechar
        setTimeout(() => {
            try {
                res.end();
            } catch (error) {
                // Ignorar erros de res.end()
            }
        }, 100);
    };

    // Adicionar listeners
    connection.on('data', dataListener);
    connection.on('error', errorListener);
    connection.on('close', closeListener);

    // Ping otimizado para manter SSE ativo
    const pingInterval = setInterval(() => {
        if (!connection.isConnected) {
            clearInterval(pingInterval);
            return;
        }
        
        try {
            res.write('data: ' + JSON.stringify({
                type: 'ping',
                timestamp: Date.now()
            }) + '\n\n');
        } catch (error) {
            clearInterval(pingInterval);
        }
    }, 20000); // A cada 20 segundos

    // Cleanup quando cliente desconectar
    req.on('close', () => {
        clearInterval(pingInterval);
        connection.off('data', dataListener);
        connection.off('error', errorListener);
        connection.off('close', closeListener);
        console.log(`📱 Cliente desconectado do stream: ${connectionId}`);
    });

    req.on('error', () => {
        clearInterval(pingInterval);
        connection.off('data', dataListener);
        connection.off('error', errorListener);
        connection.off('close', closeListener);
    });
}

function handleStatus(req, res) {
    const activeConnections = Array.from(connections.entries()).map(([id, conn]) => ({
        id,
        host: conn.host,
        port: conn.port,
        connected: conn.isConnected,
        lastActivity: conn.lastActivity,
        uptime: Date.now() - (conn.lastActivity || Date.now())
    }));

    res.json({
        success: true,
        timestamp: Date.now(),
        totalConnections: connections.size,
        connections: activeConnections,
        serverUptime: process.uptime()
    });
}
