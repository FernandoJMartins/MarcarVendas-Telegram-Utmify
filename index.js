const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const moment = require('moment');
const axios = require('axios');
const express = require('express');
const { Pool } = require('pg');
require('dotenv').config();
const cors = require('cors');
const { error } = require('console');

const app = express();

const corsOptions = {
    origin: '*', // Permite qualquer origem. Use isso para testar.
    // Em produção, mude para: origin: 'https://seu-dominio-do-frontend.com.br',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));

app.use(express.json());

const apiId = 25280297;  // seu apiId
const apiHash = 'f62f8889ed02919daf0212e9ea91c187';  // seu apiHash
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || '');

const CHAT_ID = BigInt(-1002689082095);  // coloque seu chat id aqui (grupo ou canal)

const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DO BANCO DE DADOS POSTGRESQL ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.on('connect', () => {
    console.log('✅ PostgreSQL conectado!');
});

pool.on('error', (err) => {
    console.error('❌ Erro inesperado no pool do PostgreSQL:', err);
    process.exit(-1);
});

// --- FUNÇÃO PARA INICIALIZAR TABELAS NO POSTGRESQL ---
async function setupDatabase() {
    try {
        const client = await pool.connect();
        await client.query(`
            CREATE TABLE IF NOT EXISTS vendas (
                id SERIAL PRIMARY KEY,
                chave TEXT UNIQUE NOT NULL,
                hash TEXT UNIQUE NOT NULL,
                valor REAL NOT NULL,
                utm_source TEXT,
                utm_medium TEXT,
                utm_campaign TEXT,
                utm_content TEXT,
                utm_term TEXT,
                order_id TEXT,
                transaction_id TEXT,
                ip TEXT,
                user_agent TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabela "vendas"');

        await client.query(`
            CREATE TABLE IF NOT EXISTS frontend_utms (
                id SERIAL PRIMARY KEY,
                unique_click_id TEXT UNIQUE NOT NULL, 
                timestamp_ms BIGINT NOT NULL,
                valor REAL, 
                fbclid TEXT, 
                utm_source TEXT,
                utm_medium TEXT,
                utm_campaign TEXT,
                utm_content TEXT,
                utm_term TEXT,
                ip TEXT,
                received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabela "frontend_utms"');

        await client.query(`
            CREATE TABLE IF NOT EXISTS telegram_users (
                telegram_user_id TEXT PRIMARY KEY,
                unique_click_id TEXT, 
                last_activity TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabela "telegram_users" verificada/criada no PostgreSQL.');

        client.release();
    } catch (err) {
        console.error('❌ Erro ao configurar tabelas no PostgreSQL:', err.message);
        process.exit(1);
    }
}

// --- FUNÇÕES DE UTILIDADE PARA O BANCO DE DADOS ---

function gerarChaveUnica({ transaction_id }) {
    return `chave-${transaction_id}`;
}

function gerarHash({ transaction_id }) {
    return `hash-${transaction_id}`;
}

async function salvarVenda(venda) {
    console.log('💾 Tentando salvar venda no banco (PostgreSQL)...');
    const sql = `
        INSERT INTO vendas (
            chave, hash, valor, utm_source, utm_medium,
            utm_campaign, utm_content, utm_term,
            order_id, transaction_id, ip, user_agent
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (hash) DO NOTHING;
    `;

    const valores = [
        venda.chave,
        venda.hash,
        venda.valor,
        venda.utm_source,
        venda.utm_medium,
        venda.utm_campaign,
        venda.utm_content,
        venda.utm_term,
        venda.orderId,
        venda.transaction_id,
        venda.ip,
        venda.userAgent
    ];

    try {
        const res = await pool.query(sql, valores);
        if (res.rowCount > 0) {
            console.log('✅ Venda salva no PostgreSQL!');
        } else {
            console.log('🔁 Venda já existia no PostgreSQL, ignorando inserção (hash duplicado).');
        }
    } catch (err) {
        console.error('❌ Erro ao salvar venda no DB (PostgreSQL):', err.message);
    }
}

async function vendaExiste(hash) {
    console.log(`🔎 Verificando se venda com hash ${hash} existe no PostgreSQL...`);
    const sql = 'SELECT COUNT(*) AS total FROM vendas WHERE hash = $1';
    try {
        const res = await pool.query(sql, [hash]);
        return res.rows[0].total > 0;
    } catch (err) {
        console.error('❌ Erro ao verificar venda existente (PostgreSQL):', err.message);
        return false;
    }
}

async function saveUserClickAssociation(telegramUserId, uniqueClickId) {
    try {
        await pool.query(
            `INSERT INTO telegram_users (telegram_user_id, unique_click_id, last_activity)
             VALUES ($1, $2, NOW())
             ON CONFLICT (telegram_user_id) DO UPDATE SET unique_click_id = EXCLUDED.unique_click_id, last_activity = NOW();`,
            [telegramUserId, uniqueClickId]
        );
        console.log(`✅ Associação user_id(${telegramUserId}) -> click_id(${uniqueClickId}) salva no DB.`);
    } catch (err) {
        console.error('❌ Erro ao salvar associação user_id-click_id no DB:', err.message);
    }
}

async function salvarFrontendUtms(data) {


    // Validação dos dados recebidos
    console.log('📥 Dados recebidos:', JSON.stringify(data, null, 2));

    // Verifica dados obrigatórios
    if (!data.unique_click_id || !data.timestamp) {
        console.error('❌ Dados obrigatórios faltando:', {
            unique_click_id: !!data.unique_click_id,
            timestamp: !!data.timestamp
        });
        throw new Error('unique_click_id e timestamp são obrigatórios');
    }


    const processedData = {
        ...data,
        utm_source: data.utm_source || 'direct',
        utm_medium: data.utm_medium || 'none',
        utm_campaign: data.utm_campaign || 'no_campaign',
        utm_content: data.utm_content || 'no_content',
        utm_term: data.utm_term || 'no_term',
        ip: data.ip || 'unknown'
    };



    console.log('💾 Tentando salvar UTMs do frontend no banco (PostgreSQL)...');
    const sql = `
        INSERT INTO frontend_utms (
            unique_click_id, timestamp_ms, valor, fbclid, utm_source, utm_medium,
            utm_campaign, utm_content, utm_term, ip
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        
                ON CONFLICT (unique_click_id)
        DO UPDATE SET
            timestamp_ms = EXCLUDED.timestamp_ms,
            valor = EXCLUDED.valor,
            fbclid = EXCLUDED.fbclid,
            utm_source = EXCLUDED.utm_source,
            utm_medium = EXCLUDED.utm_medium,
            utm_campaign = EXCLUDED.utm_campaign,
            utm_content = EXCLUDED.utm_content,
            utm_term = EXCLUDED.utm_term,
            ip = EXCLUDED.ip;;
    `;


    const valores = [
        processedData.unique_click_id,
        processedData.timestamp,
        processedData.valor || 0,
        processedData.fbclid || null,
        processedData.utm_source,
        processedData.utm_medium,
        processedData.utm_campaign,
        processedData.utm_content,
        processedData.utm_term,
        processedData.ip
    ];

    try {
        const result = await pool.query(sql, valores);
        console.log('✅ UTMs do frontend salvas no PostgreSQL!', {
            operação: result.rowCount === 1 ? 'INSERT' : 'UPDATE',
            clickId: processedData.unique_click_id,
            utms: {
                source: processedData.utm_source,
                medium: processedData.utm_medium,
                campaign: processedData.utm_campaign
            }
        });
        return true;
    } catch (err) {
        console.error('❌ Erro ao salvar UTMs do frontend:', err.message);
        throw err;
    }
}

async function buscarUtmsPorUniqueClickId(uniqueClickId) {
    console.log(`🔎 Buscando UTMs do frontend por unique_click_id: ${uniqueClickId}...`);
    const sql = 'SELECT * FROM frontend_utms WHERE unique_click_id = $1 ORDER BY received_at DESC LIMIT 1';
    try {
        const res = await pool.query(sql, [uniqueClickId]);
        if (res.rows.length > 0) {
            console.log(`✅ UTMs encontradas para unique_click_id ${uniqueClickId}.`);
            return res.rows[0];
        } else {
            console.log(`🔎 Nenhuma UTM do frontend encontrada para unique_click_id ${uniqueClickId}.`);
            return null;
        }
    } catch (err) {
        console.error('❌ Erro ao buscar UTMs por unique_click_id (PostgreSQL):', err.message);
        return null;
    }
}




// --- FUNÇÃO PARA LIMPAR DADOS ANTIGOS DA TABELA frontend_utms ---
async function limparFrontendUtmsAntigos() {
    console.log('🧹 limpeza UTMs...');
    const cutoffTime = moment().subtract(24, 'hours').valueOf();
    const sql = `DELETE FROM frontend_utms WHERE timestamp_ms < $1`;

    try {
        const res = await pool.query(sql, [cutoffTime]);
        console.log(`🧹 limpeza UTMs: ${res.rowCount || 0} registros removidos.`);
    } catch (err) {
        console.error('❌ Erro ao limpar UTMs antigos do frontend:', err.message);
    }
}


async function getUniqueClickId(id, res) {
    try {
        if (!id) {
            return res.status(400).json({
                error: 'Id é obrigatório'
            });
        }

        const sql = ` SELECT * FROM frontend_utms WHERE unique_click_id = $1`;

        const result = await pool.query(sql, [id])

        if (result.rows.length == 0) {
            return res.status(404).json({
                error: 'Nenhum dado encontrado'
            })
        }

        console.log(`✅ Dados encontrados para click_id: ${id}`);
        res.status(200).json({
            success: true,
            data: result.rows[0]
        });

    } catch (error) {
        console.error('❌ Erro ao buscar dados:', error);
        res.status(500).json({
            error: 'Erro interno ao buscar dados'
        });
    }
}

app.get('/id/:id', (req, res) => {
    const unique_click_id = req.params.id;
    getUniqueClickId(unique_click_id, res)
})


// --- ENDPOINT HTTP PARA RECEBER UTMs DO FRONTEND ---
app.post('/frontend-utm-data', (req, res) => {
    const { unique_click_id, timestamp, valor, fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, ip } = req.body;





    console.log('🤖 [BACKEND] Dados do frontend recebidos:', {
        unique_click_id, timestamp, valor, fbclid, utm_source, utm_medium, utm_campaign, utm_content, utm_term, ip
    });


    if (!unique_click_id || !timestamp) {
        console.error('❌ [BACKEND] Requisição inválida - dados obrigatórios ausentes');
        return res.status(400).send('unique_click_id e timestamp são obrigatórios.');
    }

    if (!unique_click_id.startsWith('click-')) {
        console.error('❌ [BACKEND] unique_click_id inválido:', unique_click_id);
        return res.status(400).send('Formato de unique_click_id inválido');
    }

    if (!unique_click_id || !timestamp || valor === undefined || valor === null) {
        return res.status(400).send('unique_click_id, Timestamp e Valor são obrigatórios.');
    }





    salvarFrontendUtms({
        unique_click_id,
        timestamp,
        valor,
        fbclid,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        ip
    });

    res.status(200).send('Dados recebidos com sucesso!');
});

// --- Endpoint para ping (manter o serviço ativo) ---
app.get('/ping', (req, res) => {
    console.log('💚 [PING]');
    res.status(200).send('Pong!');
});


// --- INICIALIZA O SERVIDOR HTTP PRIMEIRO ---
app.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP Express escutando na porta ${PORT}.`);
    console.log('Este servidor ajuda a manter o bot ativo em plataformas de hospedagem e recebe dados do frontend.');

    // Configura o auto-ping
    const pingInterval = 20 * 1000; // 20 segundos
    setInterval(() => {
        axios.get(`http://localhost:${PORT}/ping`)
            .then(response => {
                // console.log(`💚 Auto-ping bem-sucedido: ${response.status}`);
            })
            .catch(error => {
                console.error(`💔 Erro no auto-ping: ${error.message}`);
            });
    }, pingInterval);
    console.log(`⚡ Auto-ping configurado para cada ${pingInterval / 1000} segundos.`);


    // --- APÓS O SERVIDOR HTTP ESTAR ESCUTANDO, INICIA AS TAREFAS ASSÍNCRONAS ---
    (async () => {
        // Configura o banco de dados
        try {
            await setupDatabase();
            console.log('✅ Configuração do banco de dados concluída.');
        } catch (dbError) {
            console.error('❌ Erro fatal na configuração do banco de dados:', dbError.message);
            process.exit(1);
        }

        limparFrontendUtmsAntigos();

        setInterval(limparFrontendUtmsAntigos, 60 * 60 * 1000);

        console.log('Iniciando userbot...');
        const client = new TelegramClient(stringSession, apiId, apiHash, {
            connectionRetries: 5,
        });

        try {
            await client.start({
                phoneNumber: async () => input.text('Digite seu número com DDI (ex: +5511987654321): '),
                password: async () => input.text('Senha 2FA (se tiver): '),
                phoneCode: async () => input.text('Código do Telegram: '),
                onError: (err) => console.log('Erro durante o login/start do cliente:', err),
            });
            console.log('✅ Userbot conectado!');
            console.log('🔑 Nova StringSession para .env (após o primeiro login):', client.session.save());
        } catch (error) {
            console.error('❌ Falha ao iniciar o userbot:', error.message);
            process.exit(1);
        }



        // --- MANIPULAÇÃO DE MENSAGENS ---
        client.addEventHandler(async (event) => {
            const message = event.message;  // assim tem acesso correto ao objeto Message
            if (!message || !message.message) {
                console.log('Mensagem inválida ou vazia, ignorando...');
                return;
            }

            const msgText = message.message;

            const chat = await message.getChat();
            const incomingChatId = chat.id;

            let normalizedIncomingChatId = incomingChatId;
            if (typeof incomingChatId === 'bigint') {
                if (incomingChatId < 0 && incomingChatId.toString().startsWith('-100')) {
                    normalizedIncomingChatId = BigInt(incomingChatId.toString().substring(4));
                } else if (incomingChatId < 0) {
                    normalizedIncomingChatId = BigInt(incomingChatId * BigInt(-1));
                }
            } else {
                normalizedIncomingChatId = BigInt(Math.abs(Number(incomingChatId)));
            }

            let normalizedConfiguredChatId = CHAT_ID;
            if (typeof CHAT_ID === 'bigint') {
                if (CHAT_ID < 0 && CHAT_ID.toString().startsWith('-100')) {
                    normalizedConfiguredChatId = BigInt(CHAT_ID.toString().substring(4));
                } else if (CHAT_ID < 0) {
                    normalizedConfiguredChatId = BigInt(CHAT_ID * BigInt(-1));
                }
            } else {
                normalizedConfiguredChatId = BigInt(Math.abs(Number(CHAT_ID)));
            }

            if (normalizedIncomingChatId !== normalizedConfiguredChatId) {
                return;
            }

            let texto = ''; // Inicializa como string vazia
            if (message.message != null) { // Verifica se message.message existe e não é null/undefined
                texto = String(message.message).replace(/\r/g, '').trim();
            }

            if (texto.startsWith('/start ')) {
                const startPayload = decodeURIComponent(texto.substring('/start '.length).trim());
                await saveUserClickAssociation(message.senderId.toString(), startPayload);
                console.log(`🤖 [BOT] User ${message.senderId} iniciado com unique_click_id: ${startPayload}`);
                return;
            }

            const idRegex = /ID\s+Transa(?:ç|c)[aã]o\s+Gateway[:：]?\s*([\w-]{10,})/i;
            const valorLiquidoRegex = /Valor\s+L[ií]quido[:：]?\s*R?\$?\s*([\d.,]+)/i;
            const codigoDeVendaRegex = /Código\s+de\s+Venda[:：]?\s*(.+)/i;
            const nomeCompletoRegex = /Nome\s+Completo[:：]?\s*(.+)/i;
            const emailRegex = /E-mail[:：]?\s*(\S+@\S+\.\S+)/i;
            const metodoPagamentoRegex = /M[ée]todo\s+Pagamento[:：]?\s*(.+)/i;
            const plataformaPagamentoRegex = /Plataforma\s+Pagamento[:：]?\s*(.+)/i;


            const idMatch = texto.match(idRegex);
            const valorLiquidoMatch = texto.match(valorLiquidoRegex);
            const codigoDeVendaMatch = texto.match(codigoDeVendaRegex);

            const telegramMessageTimestamp = message.date * 1000;

            const nomeMatch = texto.match(nomeCompletoRegex);
            const emailMatch = texto.match(emailRegex);
            const metodoPagamentoMatch = texto.match(metodoPagamentoRegex);
            const plataformaPagamentoMatch = texto.match(plataformaPagamentoRegex);

            const customerName = nomeMatch ? nomeMatch[1].trim() : "Cliente Desconhecido";
            const customerEmail = emailMatch ? emailMatch[1].trim() : "desconhecido@email.com";
            const paymentMethod = metodoPagamentoMatch ? metodoPagamentoMatch[1].trim().toLowerCase().replace(' ', '_') : 'unknown';
            const platform = plataformaPagamentoMatch ? plataformaPagamentoMatch[1].trim() : 'UnknownPlatform';
            const status = 'paid';

            if (!idMatch || !valorLiquidoMatch) {
                console.log('⚠️ Mensagem sem dados completos de venda (ID da Transação Gateway ou Valor Líquido não encontrados).');
                return;
            }

            try {
                const transaction_id = idMatch[1].trim();
                const valorLiquidoNum = parseFloat(valorLiquidoMatch[1].replace(/\./g, '').replace(',', '.').trim());

                if (isNaN(valorLiquidoNum) || valorLiquidoNum <= 0) {
                    console.log('⚠️ Valor Líquido numérico inválido ou menor/igual a zero:', valorLiquidoMatch[1]);
                    return;
                }

                const chave = gerarChaveUnica({ transaction_id });
                const hash = gerarHash({ transaction_id });

                const jaExiste = await vendaExiste(hash);
                if (jaExiste) {
                    console.log(`🔁 Venda com hash ${hash} já registrada. Ignorando duplicata.`);
                    return;
                }

                let utmsEncontradas = {
                    utm_source: null,
                    utm_medium: null,
                    utm_campaign: null,
                    utm_content: null,
                    utm_term: null
                };
                let ipClienteFrontend = 'telegram';
                let matchedFrontendUtms = null;

                // LÓGICA DE BUSCA ÚNICA: Prioriza APENAS o Código de Venda da mensagem
                const extractedCodigoDeVenda = codigoDeVendaMatch ? codigoDeVendaMatch[1].trim() : null;

                if (!extractedCodigoDeVenda) {
                    console.log('⚠️ [BOT] Código de Venda não encontrado na mensagem');
                    return;
                }

                try {
                    if (extractedCodigoDeVenda.startsWith("click")) {
                        console.log(`🤖 [BOT] Tentando encontrar UTMs pelo Código de Venda: ${extractedCodigoDeVenda}`);
                        matchedFrontendUtms = await buscarUtmsPorUniqueClickId(extractedCodigoDeVenda);

                        if (!matchedFrontendUtms) {
                            console.log(`⚠️ [BOT] UTMs não encontradas para Código de Venda: ${extractedCodigoDeVenda}`);
                            return; // Retorna se não encontrar UTMs
                        }
                    } else {
                        console.log(`⚠️ [BOT] Código de Venda não começa com "click": ${extractedCodigoDeVenda}`);
                        return;
                    }
                } catch (err) {
                    console.error('❌ [BOT] Erro ao buscar UTMs:', err);
                    return;
                }

                // Os fallbacks anteriores por user_id e timestamp/IP foram REMOVIDOS,
                // pois a busca agora é estritamente pelo Código de Venda.

                if (matchedFrontendUtms) {
                    utmsEncontradas = {
                        utm_source: matchedFrontendUtms.utm_source || 'no_source',
                        utm_medium: matchedFrontendUtms.utm_medium || 'no_medium',
                        utm_campaign: matchedFrontendUtms.utm_campaign || 'no_campaign',
                        utm_content: matchedFrontendUtms.utm_content || 'no_content',
                        utm_term: matchedFrontendUtms.utm_term || 'no_term'
                    };
                    ipClienteFrontend = matchedFrontendUtms.ip || 'frontend_matched';
                    console.log(`--------------------------`);
                    console.log(`--------------------------`);
                    console.log(`✅ [BOT] UTMs para ${transaction_id} atribuídas!`);
                    console.log(matchedFrontendUtms);
                    console.log(`--------------------------`);
                    console.log(`--------------------------`);
                } else {
                    console.log(`⚠️ [BOT] Nenhuma UTM correspondente encontrada para ${transaction_id} usando o Código de Venda. Enviando para UTMify sem UTMs de atribuição.`);
                }

                const orderId = transaction_id;
                const agoraUtc = moment.utc().format('YYYY-MM-DD HH:mm:ss');

                const payload = {
                    orderId: orderId,
                    platform: platform,
                    paymentMethod: paymentMethod,
                    status: status,
                    createdAt: agoraUtc,
                    approvedDate: agoraUtc,
                    customer: {
                        name: customerName,
                        email: customerEmail,
                        phone: null,
                        document: null,
                        country: 'BR',
                        ip: ipClienteFrontend,
                    },
                    products: [
                        {
                            id: 'acesso-vip-bundle',
                            name: 'Acesso VIP',
                            planId: null,
                            planName: null,
                            quantity: 1,
                            priceInCents: Math.round(valorLiquidoNum * 100)
                        }
                    ],
                    trackingParameters: utmsEncontradas,
                    commission: {
                        totalPriceInCents: Math.round(valorLiquidoNum * 100),
                        gatewayFeeInCents: 0,
                        userCommissionInCents: Math.round(valorLiquidoNum * 100),
                        currency: 'BRL'
                    },
                    isTest: false
                };

                for (const key in payload.trackingParameters) {
                    if (payload.trackingParameters[key] === '') {
                        payload.trackingParameters[key] = null;
                    }
                }

                console.log(' -------------------------');
                console.log(' -------------------------');
                console.log('📬 [BOT] Payload enviado para UTMIFY:', payload);

                console.log(' -------------------------');
                console.log(' -------------------------');


                const res = await axios.post('https://api.utmify.com.br/api-credentials/orders', payload, {
                    headers: {
                        'x-api-token': process.env.API_KEY,
                        'Content-Type': 'application/json'
                    }
                });



                salvarVenda({
                    chave,
                    hash,
                    valor: valorLiquidoNum,
                    utm_source: utmsEncontradas.utm_source,
                    utm_medium: utmsEncontradas.utm_medium,
                    utm_campaign: utmsEncontradas.utm_campaign,
                    utm_content: utmsEncontradas.utm_content,
                    utm_term: utmsEncontradas.utm_term,
                    orderId,
                    transaction_id,
                    ip: ipClienteFrontend,
                    userAgent: 'userbot'
                });

            } catch (err) {
                console.error('❌ [BOT] Erro ao processar mensagem ou enviar para UTMify:', err.message);
                if (err.response) {
                    console.error('🛑 [BOT] Código de status da UTMify:', err.response.status);
                    console.error('📩 [BOT] Resposta de erro da UTMify:', err.response.data);
                }
            }

        }, new NewMessage({ chats: [CHAT_ID] }));
    })();
});