// ============================================
// 📱 WhatsApp Client Manager - إدارة جلسات واتساب
// الإصدار: 2.0.0 - Render Optimized
// الميزات: إدارة متعددة للجلسات + QR Code + تجميع تلقائي
// ============================================

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');

// استيراد النماذج من الملف الرئيسي
const { 
    WhatsAppSession, 
    CollectedLink,
    AutoReply,
    AutoJoin
} = require('./index');

class WhatsAppClientManager {
    constructor() {
        console.log('🤖 بدء تهيئة مدير جلسات WhatsApp...');
        
        // تخزين الجلسات النشطة
        this.clients = new Map(); // sessionId -> client
        this.clientData = new Map(); // sessionId -> metadata
        this.qrCodes = new Map(); // sessionId -> qr data
        
        // إعدادات النظام
        this.settings = {
            maxClients: 10,
            qrTimeout: 60000,
            reconnectAttempts: 3
        };
        
        // معالجات الأحداث
        this.setupEventHandlers();
        
        console.log('✅ مدير جلسات WhatsApp مهيأ وجاهز');
    }
    
    // ============================================
    // 1. إعداد معالجات الأحداث
    // ============================================
    setupEventHandlers() {
        process.on('unhandledRejection', (reason, promise) => {
            console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
        });
        
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
        });
    }
    
    // ============================================
    // 2. إنشاء جلسة واتساب جديدة
    // ============================================
    async createSession(sessionData) {
        const {
            sessionId,
            phoneNumber,
            adminId,
            chatId,
            settings = {}
        } = sessionData;
        
        console.log(`📱 جاري إنشاء جلسة جديدة: ${sessionId} (${phoneNumber})`);
        
        try {
            // التحقق من الحد الأقصى للجلسات
            if (this.clients.size >= this.settings.maxClients) {
                throw new Error(`وصلت للحد الأقصى للجلسات: ${this.settings.maxClients}`);
            }
            
            // التحقق من عدم تكرار الجلسة
            if (this.clients.has(sessionId)) {
                throw new Error(`الجلسة ${sessionId} موجودة مسبقاً`);
            }
            
            // حفظ الجلسة في قاعدة البيانات
            const session = await WhatsAppSession.create({
                id: sessionId,
                sessionId: sessionId,
                phoneNumber: phoneNumber,
                adminId: adminId,
                status: 'awaiting_qr',
                settings: {
                    autoReply: true,
                    autoCollect: true,
                    autoJoin: false,
                    broadcastEnabled: true,
                    ...settings
                },
                metadata: {
                    createdFrom: 'whatsapp_manager',
                    platform: 'render',
                    userAgent: 'WhatsApp-Bot/2.0.0'
                }
            });
            
            console.log(`✅ تم حفظ الجلسة في قاعدة البيانات: ${sessionId}`);
            
            // إعداد عميل واتساب
            const client = this.setupWhatsAppClient(sessionId, phoneNumber, adminId, chatId);
            
            // تخزين البيانات
            this.clients.set(sessionId, client);
            this.clientData.set(sessionId, {
                phoneNumber,
                adminId,
                chatId,
                createdAt: new Date(),
                lastActivity: new Date(),
                reconnectAttempts: 0
            });
            
            // تهيئة العميل
            await client.initialize();
            
            console.log(`🚀 تم تهيئة عميل WhatsApp للجلسة: ${sessionId}`);
            
            return {
                success: true,
                sessionId: sessionId,
                message: 'تم إنشاء الجلسة بنجاح، انتظر QR Code'
            };
            
        } catch (error) {
            console.error(`❌ خطأ في إنشاء الجلسة ${sessionId}:`, error);
            
            // تحديث حالة الجلسة في قاعدة البيانات
            await WhatsAppSession.update(
                { status: 'error' },
                { where: { id: sessionId } }
            );
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // ============================================
    // 3. إعداد عميل واتساب
    // ============================================
    setupWhatsAppClient(sessionId, phoneNumber, adminId, chatId) {
        console.log(`🔧 جاري إعداد عميل WhatsApp للجلسة: ${sessionId}`);
        
        // إعداد عميل واتساب مع LocalAuth
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: sessionId,
                dataPath: './sessions'
            }),
            puppeteer: {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    '--window-size=1920,1080'
                ],
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
            },
            qrTimeout: this.settings.qrTimeout,
            takeoverOnConflict: true,
            takeoverTimeoutMs: 5000,
            restartOnAuthFail: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        // معالج QR Code
        client.on('qr', async (qr) => {
            await this.handleQRCode(qr, sessionId, phoneNumber, adminId, chatId);
        });
        
        // عند جاهزية العميل
        client.on('ready', async () => {
            await this.handleClientReady(client, sessionId, phoneNumber, adminId, chatId);
        });
        
        // عند استقبال رسالة
        client.on('message', async (message) => {
            await this.handleWhatsAppMessage(message, sessionId);
        });
        
        // عند حدوث تغيير في الحالة
        client.on('change_state', async (state) => {
            await this.handleStateChange(state, sessionId);
        });
        
        // عند فقدان الاتصال
        client.on('disconnected', async (reason) => {
            await this.handleDisconnection(reason, sessionId);
        });
        
        // عند حدوث خطأ في المصادقة
        client.on('auth_failure', async (error) => {
            await this.handleAuthFailure(error, sessionId);
        });
        
        // عند فشل التحميل
        client.on('loading_screen', async (percent, message) => {
            await this.handleLoadingScreen(percent, message, sessionId);
        });
        
        console.log(`✅ تم إعداد عميل WhatsApp للجلسة: ${sessionId}`);
        
        return client;
    }
    
    // ============================================
    // 4. معالجة QR Code
    // ============================================
    async handleQRCode(qr, sessionId, phoneNumber, adminId, chatId) {
        console.log(`📱 تم توليد QR Code للجلسة: ${sessionId}`);
        
        try {
            // حفظ QR في الذاكرة
            this.qrCodes.set(sessionId, {
                qr: qr,
                timestamp: Date.now(),
                phoneNumber: phoneNumber,
                adminId: adminId,
                chatId: chatId
            });
            
            // تحديث الجلسة في قاعدة البيانات
            await WhatsAppSession.update(
                {
                    qrCode: qr,
                    qrSentAt: new Date(),
                    status: 'awaiting_qr',
                    lastActivity: new Date()
                },
                { where: { id: sessionId } }
            );
            
            console.log(`✅ تم حفظ QR Code للجلسة: ${sessionId}`);
            
            return {
                success: true,
                sessionId: sessionId,
                qr: qr,
                phoneNumber: phoneNumber,
                timestamp: new Date()
            };
            
        } catch (error) {
            console.error(`❌ خطأ في معالجة QR Code للجلسة ${sessionId}:`, error);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // ============================================
    // 5. معالجة جاهزية العميل
    // ============================================
    async handleClientReady(client, sessionId, phoneNumber, adminId, chatId) {
        console.log(`✅ WhatsApp جاهز للجلسة: ${sessionId} (${phoneNumber})`);
        
        try {
            // جمع معلومات الاتصال
            const connectionData = {
                platform: client.info?.platform || 'unknown',
                phone: client.info?.phone || {},
                pushname: client.info?.pushname || '',
                wid: client.info?.wid?._serialized || '',
                me: client.info?.me || {}
            };
            
            // تحديث الجلسة في قاعدة البيانات
            await WhatsAppSession.update(
                {
                    status: 'connected',
                    connectedAt: new Date(),
                    connectionData: connectionData,
                    lastActivity: new Date(),
                    stats: {
                        messagesReceived: 0,
                        messagesSent: 0,
                        linksCollected: 0,
                        groupsJoined: 0
                    }
                },
                { where: { id: sessionId } }
            );
            
            // مسح QR من الذاكرة
            this.qrCodes.delete(sessionId);
            
            // تحديث بيانات العميل
            const clientData = this.clientData.get(sessionId);
            if (clientData) {
                clientData.lastActivity = new Date();
                clientData.connectionData = connectionData;
                clientData.reconnectAttempts = 0;
            }
            
            console.log(`✅ تم تحديث حالة الجلسة ${sessionId} إلى متصل`);
            
            return {
                success: true,
                sessionId: sessionId,
                phoneNumber: phoneNumber,
                connectionData: connectionData,
                message: 'تم الاتصال بحساب WhatsApp بنجاح'
            };
            
        } catch (error) {
            console.error(`❌ خطأ في معالجة جاهزية الجلسة ${sessionId}:`, error);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // ============================================
    // 6. معالجة رسائل واتساب
    // ============================================
    async handleWhatsAppMessage(message, sessionId) {
        try {
            // تحديث إحصائيات الجلسة
            await this.updateSessionStats(sessionId, 'messagesReceived');
            
            // تحديث آخر نشاط
            await this.updateLastActivity(sessionId);
            
            // 1. تجميع الروابط من الرسالة
            await this.collectLinksFromMessage(message, sessionId);
            
            // 2. التحقق من الردود التلقائية
            await this.checkAutoReplies(message, sessionId);
            
            // 3. اكتشاف روابط الانضمام
            await this.detectJoinLinks(message, sessionId);
            
            console.log(`📨 تم معالجة رسالة للجلسة ${sessionId} من ${message.from}`);
            
        } catch (error) {
            console.error(`❌ خطأ في معالجة رسالة للجلسة ${sessionId}:`, error);
        }
    }
    
    async updateSessionStats(sessionId, statType) {
        try {
            const session = await WhatsAppSession.findByPk(sessionId);
            if (session) {
                const stats = session.stats || {};
                
                switch (statType) {
                    case 'messagesReceived':
                        stats.messagesReceived = (stats.messagesReceived || 0) + 1;
                        break;
                    case 'messagesSent':
                        stats.messagesSent = (stats.messagesSent || 0) + 1;
                        break;
                    case 'linksCollected':
                        stats.linksCollected = (stats.linksCollected || 0) + 1;
                        break;
                    case 'groupsJoined':
                        stats.groupsJoined = (stats.groupsJoined || 0) + 1;
                        break;
                }
                
                await session.update({ 
                    stats,
                    lastActivity: new Date() 
                });
            }
        } catch (error) {
            console.error(`❌ خطأ في تحديث إحصائيات الجلسة ${sessionId}:`, error);
        }
    }
    
    async updateLastActivity(sessionId) {
        try {
            await WhatsAppSession.update(
                { lastActivity: new Date() },
                { where: { id: sessionId } }
            );
            
            const clientData = this.clientData.get(sessionId);
            if (clientData) {
                clientData.lastActivity = new Date();
            }
        } catch (error) {
            console.error(`❌ خطأ في تحديث آخر نشاط للجلسة ${sessionId}:`, error);
        }
    }
    
    // ============================================
    // 7. تجميع الروابط من الرسائل
    // ============================================
    async collectLinksFromMessage(message, sessionId) {
        try {
            if (!message.body) return;
            
            // استخراج جميع الروابط
            const urlRegex = /(https?:\/\/[^\s]+)/g;
            const links = message.body.match(urlRegex) || [];
            
            let collectedCount = 0;
            
            for (const url of links) {
                // تصنيف الرابط
                let type = 'other';
                if (url.includes('chat.whatsapp.com')) type = 'whatsapp_group';
                else if (url.includes('whatsapp.com')) type = 'whatsapp_invite';
                else if (url.includes('t.me') || url.includes('telegram.me')) type = 'telegram';
                else if (url.includes('discord.gg')) type = 'discord';
                else if (url.includes('signal.group')) type = 'signal';
                else if (url.includes('http')) type = 'website';
                
                // التحقق من عدم التكرار
                const existing = await CollectedLink.findOne({
                    where: { url: url }
                });
                
                if (existing) {
                    // تحديث وقت الاكتشاف الأخير
                    await existing.update({
                        lastChecked: new Date(),
                        checkCount: (existing.checkCount || 0) + 1
                    });
                    continue;
                }
                
                // حفظ الرابط الجديد
                await CollectedLink.create({
                    url: url,
                    type: type,
                    title: `رابط من ${message.from || 'مجهول'}`,
                    description: message.body.substring(0, 200),
                    source: message.from,
                    sessionId: sessionId,
                    collectedAt: new Date(),
                    lastChecked: new Date(),
                    metadata: {
                        sender: message.from,
                        timestamp: message.timestamp,
                        hasMedia: !!message.hasMedia,
                        messageType: message.type || 'text'
                    },
                    status: 'active'
                });
                
                collectedCount++;
                
                console.log(`✅ رابط جديد محفوظ للجلسة ${sessionId}: ${type} - ${url.substring(0, 50)}...`);
            }
            
            if (collectedCount > 0) {
                await this.updateSessionStats(sessionId, 'linksCollected');
            }
            
        } catch (error) {
            console.error(`❌ خطأ في تجميع الروابط للجلسة ${sessionId}:`, error);
        }
    }
    
    // ============================================
    // 8. نظام الردود التلقائية
    // ============================================
    async checkAutoReplies(message, sessionId) {
        try {
            // الحصول على إعدادات الجلسة
            const session = await WhatsAppSession.findByPk(sessionId);
            if (!session?.settings?.autoReply) return;
            
            // الحصول على جميع الردود التلقائية النشطة لهذه الجلسة
            const autoReplies = await AutoReply.findAll({
                where: {
                    [Op.or]: [
                        { sessionId: sessionId },
                        { sessionId: null }
                    ],
                    isActive: true
                },
                order: [['priority', 'DESC']]
            });
            
            for (const reply of autoReplies) {
                if (this.shouldTriggerAutoReply(message, reply)) {
                    await this.sendAutoReply(message, reply, sessionId);
                    
                    // تحديث الإحصائيات
                    const stats = reply.stats || {};
                    stats.triggered = (stats.triggered || 0) + 1;
                    stats.lastTriggered = new Date();
                    stats.bySession = stats.bySession || {};
                    stats.bySession[sessionId] = (stats.bySession[sessionId] || 0) + 1;
                    
                    await reply.update({ stats });
                    
                    console.log(`🤖 تم إرسال رد تلقائي للجلسة ${sessionId}: ${reply.name}`);
                    
                    // خروج بعد أول رد مناسب (الأولوية الأعلى)
                    if (reply.priority >= 5) break;
                }
            }
            
        } catch (error) {
            console.error(`❌ خطأ في الرد التلقائي للجلسة ${sessionId}:`, error);
        }
    }
    
    shouldTriggerAutoReply(message, reply) {
        const text = message.body || '';
        const isGroup = message.from.includes('@g.us');
        
        // التحقق من نوع المحادثة
        if (reply.triggerType === 'private' && isGroup) return false;
        if (reply.triggerType === 'group' && !isGroup) return false;
        
        // التحقق من الشروط الإضافية
        const conditions = reply.conditions || {};
        
        // التحقق من نطاق الوقت
        if (conditions.timeRange) {
            const now = new Date();
            const hours = now.getHours();
            const [start, end] = conditions.timeRange.split('-').map(Number);
            if (hours < start || hours >= end) return false;
        }
        
        // التحقق من أيام الأسبوع
        if (conditions.daysOfWeek && conditions.daysOfWeek.length > 0) {
            const day = new Date().getDay();
            if (!conditions.daysOfWeek.includes(day)) return false;
        }
        
        // التحقق من الكلمات المطلوبة
        if (conditions.requireKeywords && conditions.requireKeywords.length > 0) {
            const hasRequired = conditions.requireKeywords.some(keyword => 
                text.toLowerCase().includes(keyword.toLowerCase())
            );
            if (!hasRequired) return false;
        }
        
        // التحقق من الكلمات المستبعدة
        if (conditions.excludeKeywords && conditions.excludeKeywords.length > 0) {
            const hasExcluded = conditions.excludeKeywords.some(keyword => 
                text.toLowerCase().includes(keyword.toLowerCase())
            );
            if (hasExcluded) return false;
        }
        
        // التحقق من المحتوى الرئيسي
        switch (reply.matchType) {
            case 'exact':
                return text.trim() === reply.trigger;
            case 'contains':
                return text.toLowerCase().includes(reply.trigger.toLowerCase());
            case 'regex':
                try {
                    const regex = new RegExp(reply.trigger, 'i');
                    return regex.test(text);
                } catch {
                    return false;
                }
            case 'starts_with':
                return text.toLowerCase().startsWith(reply.trigger.toLowerCase());
            case 'ends_with':
                return text.toLowerCase().endsWith(reply.trigger.toLowerCase());
            default:
                return false;
        }
    }
    
    async sendAutoReply(message, reply, sessionId) {
        try {
            const client = this.clients.get(sessionId);
            if (!client) {
                console.log(`❌ العميل غير متصل للجلسة: ${sessionId}`);
                return;
            }
            
            switch (reply.responseType) {
                case 'text':
                    await client.sendMessage(message.from, reply.response);
                    break;
                case 'image':
                    // معالجة الصور
                    await client.sendMessage(message.from, reply.response);
                    break;
                default:
                    await client.sendMessage(message.from, reply.response);
            }
            
            // تحديث إحصائيات الجلسة
            await this.updateSessionStats(sessionId, 'messagesSent');
            
        } catch (error) {
            console.error(`❌ خطأ في إرسال الرد التلقائي للجلسة ${sessionId}:`, error);
            
            // تحديث إحصائيات الفشل
            const replyStats = reply.stats || {};
            replyStats.failed = (replyStats.failed || 0) + 1;
            await reply.update({ stats: replyStats });
        }
    }
    
    // ============================================
    // 9. اكتشاف روابط الانضمام
    // ============================================
    async detectJoinLinks(message, sessionId) {
        try {
            if (!message.body) return;
            
            // البحث عن روابط انضمام واتساب
            const whatsappInviteRegex = /(https?:\/\/chat\.whatsapp\.com\/[^\s]+)/g;
            const inviteLinks = message.body.match(whatsappInviteRegex) || [];
            
            for (const link of inviteLinks) {
                await this.processDetectedJoinLink(link, sessionId);
            }
            
        } catch (error) {
            console.error(`❌ خطأ في اكتشاف روابط الانضمام للجلسة ${sessionId}:`, error);
        }
    }
    
    async processDetectedJoinLink(link, sessionId) {
        try {
            // التحقق إذا كان الرابط محفوظاً مسبقاً
            const existing = await CollectedLink.findOne({
                where: { url: link }
            });
            
            if (existing) {
                // تحديث وقت الاكتشاف الأخير
                await existing.update({
                    lastChecked: new Date(),
                    checkCount: (existing.checkCount || 0) + 1,
                    status: 'active'
                });
            } else {
                // حفظ الرابط جديد
                await CollectedLink.create({
                    url: link,
                    type: 'whatsapp_group',
                    title: 'دعوة انضمام لمجموعة واتساب',
                    description: 'تم اكتشافه تلقائياً من الرسائل',
                    source: 'auto_detection',
                    sessionId: sessionId,
                    collectedAt: new Date(),
                    lastChecked: new Date(),
                    metadata: {
                        detectedAt: new Date(),
                        autoDetected: true
                    },
                    status: 'active'
                });
            }
            
            // محاولة الانضمام إذا كان النظام مفعلاً
            const autoJoin = await AutoJoin.findOne({
                where: {
                    sessionId: sessionId,
                    status: 'active'
                }
            });
            
            if (autoJoin) {
                await this.joinWhatsAppGroup(link, sessionId);
            }
            
        } catch (error) {
            console.error(`❌ خطأ في معالجة رابط الانضمام للجلسة ${sessionId}:`, error);
        }
    }
    
    async joinWhatsAppGroup(inviteLink, sessionId) {
        try {
            const client = this.clients.get(sessionId);
            if (!client) {
                console.log(`❌ العميل غير متصل للانضمام: ${sessionId}`);
                return false;
            }
            
            // استخراج كود الدعوة من الرابط
            const inviteCode = inviteLink.split('/').pop();
            
            console.log(`➕ محاولة الانضمام للمجموعة: ${inviteLink} - الجلسة: ${sessionId}`);
            
            // محاولة الانضمام
            await client.acceptInvite(inviteCode);
            
            console.log(`✅ تم الانضمام بنجاح للمجموعة: ${inviteLink}`);
            
            // تحديث حالة الرابط
            await CollectedLink.update(
                { status: 'joined' },
                { where: { url: inviteLink } }
            );
            
            // تحديث إحصائيات الانضمام التلقائي
            const autoJoin = await AutoJoin.findOne({
                where: { sessionId: sessionId, status: 'active' }
            });
            
            if (autoJoin) {
                const stats = autoJoin.stats || {};
                stats.joined = (stats.joined || 0) + 1;
                stats.totalLinks = (stats.totalLinks || 0) + 1;
                stats.successRate = stats.joined / stats.totalLinks * 100;
                stats.lastJoinAt = new Date();
                stats.lastLinks = [...(stats.lastLinks || []).slice(-9), inviteLink];
                
                await autoJoin.update({ stats });
            }
            
            // تحديث إحصائيات الجلسة
            await this.updateSessionStats(sessionId, 'groupsJoined');
            
            return true;
            
        } catch (error) {
            console.error(`❌ فشل الانضمام للمجموعة: ${error.message} - الجلسة: ${sessionId}`);
            
            // تحديث إحصائيات الفشل
            const autoJoin = await AutoJoin.findOne({
                where: { sessionId: sessionId, status: 'active' }
            });
            
            if (autoJoin) {
                const stats = autoJoin.stats || {};
                stats.failed = (stats.failed || 0) + 1;
                stats.totalLinks = (stats.totalLinks || 0) + 1;
                stats.successRate = stats.joined / stats.totalLinks * 100;
                stats.lastError = error.message;
                
                await autoJoin.update({ stats });
            }
            
            return false;
        }
    }
    
    // ============================================
    // 10. معالجة تغيير الحالة
    // ============================================
    async handleStateChange(state, sessionId) {
        console.log(`📡 تغيير حالة الجلسة ${sessionId}: ${state}`);
        
        try {
            await WhatsAppSession.update(
                { 
                    status: state,
                    lastActivity: new Date() 
                },
                { where: { id: sessionId } }
            );
            
            console.log(`✅ تم تحديث حالة الجلسة ${sessionId} إلى: ${state}`);
            
        } catch (error) {
            console.error(`❌ خطأ في تحديث حالة الجلسة ${sessionId}:`, error);
        }
    }
    
    // ============================================
    // 11. معالجة فقدان الاتصال
    // ============================================
    async handleDisconnection(reason, sessionId) {
        console.log(`❌ فقدان الاتصال بالجلسة ${sessionId}: ${reason}`);
        
        try {
            await WhatsAppSession.update(
                {
                    status: 'disconnected',
                    disconnectedAt: new Date(),
                    lastActivity: new Date()
                },
                { where: { id: sessionId } }
            );
            
            // محاولة إعادة الاتصال
            await this.attemptReconnection(sessionId);
            
            console.log(`✅ تم تحديث حالة الجلسة ${sessionId} إلى مفصول`);
            
        } catch (error) {
            console.error(`❌ خطأ في معالجة فقدان الاتصال للجلسة ${sessionId}:`, error);
        }
    }
    
    async attemptReconnection(sessionId) {
        const clientData = this.clientData.get(sessionId);
        if (!clientData) return;
        
        // زيادة عدد محاولات إعادة الاتصال
        clientData.reconnectAttempts = (clientData.reconnectAttempts || 0) + 1;
        
        if (clientData.reconnectAttempts <= this.settings.reconnectAttempts) {
            console.log(`🔄 محاولة إعادة الاتصال للجلسة ${sessionId} (المحاولة ${clientData.reconnectAttempts}/${this.settings.reconnectAttempts})`);
            
            setTimeout(async () => {
                try {
                    const client = this.clients.get(sessionId);
                    if (client) {
                        await client.initialize();
                    }
                } catch (error) {
                    console.error(`❌ فشل إعادة الاتصال للجلسة ${sessionId}:`, error);
                }
            }, 5000);
            
        } else {
            console.log(`⏹️ توقفت محاولات إعادة الاتصال للجلسة ${sessionId}`);
        }
    }
    
    // ============================================
    // 12. معالجة فشل المصادقة
    // ============================================
    async handleAuthFailure(error, sessionId) {
        console.error(`❌ فشل المصادقة للجلسة ${sessionId}:`, error);
        
        try {
            await WhatsAppSession.update(
                {
                    status: 'error',
                    lastActivity: new Date()
                },
                { where: { id: sessionId } }
            );
            
        } catch (error) {
            console.error(`❌ خطأ في معالجة فشل المصادقة للجلسة ${sessionId}:`, error);
        }
    }
    
    // ============================================
    // 13. معالجة شاشة التحميل
    // ============================================
    async handleLoadingScreen(percent, message, sessionId) {
        console.log(`⏳ تحميل الجلسة ${sessionId}: ${percent}% - ${message}`);
        
        try {
            await WhatsAppSession.update(
                {
                    status: 'loading',
                    lastActivity: new Date()
                },
                { where: { id: sessionId } }
            );
            
        } catch (error) {
            console.error(`❌ خطأ في تحديث حالة التحميل للجلسة ${sessionId}:`, error);
        }
    }
    
    // ============================================
    // 14. إدارة الجلسات
    // ============================================
    async getSession(sessionId) {
        return {
            client: this.clients.get(sessionId),
            data: this.clientData.get(sessionId),
            qrCode: this.qrCodes.get(sessionId)
        };
    }
    
    async getAllSessions() {
        const sessions = [];
        
        for (const [sessionId, client] of this.clients.entries()) {
            const data = this.clientData.get(sessionId);
            const qrCode = this.qrCodes.get(sessionId);
            
            sessions.push({
                sessionId,
                client: client ? 'connected' : 'disconnected',
                data,
                hasQR: !!qrCode
            });
        }
        
        return sessions;
    }
    
    async getActiveSessions() {
        const activeSessions = [];
        
        for (const [sessionId, client] of this.clients.entries()) {
            if (client) {
                const data = this.clientData.get(sessionId);
                activeSessions.push({
                    sessionId,
                    phoneNumber: data?.phoneNumber,
                    adminId: data?.adminId,
                    lastActivity: data?.lastActivity
                });
            }
        }
        
        return activeSessions;
    }
    
    async getSessionQR(sessionId) {
        const qrData = this.qrCodes.get(sessionId);
        
        if (!qrData) {
            return {
                success: false,
                error: 'QR Code غير موجود أو منتهي الصلاحية'
            };
        }
        
        // التحقق من صلاحية QR Code
        const now = Date.now();
        const qrAge = now - qrData.timestamp;
        
        if (qrAge > this.settings.qrTimeout) {
            this.qrCodes.delete(sessionId);
            return {
                success: false,
                error: 'QR Code منتهي الصلاحية'
            };
        }
        
        return {
            success: true,
            qr: qrData.qr,
            phoneNumber: qrData.phoneNumber,
            timestamp: qrData.timestamp,
            age: qrAge,
            expiresIn: this.settings.qrTimeout - qrAge
        };
    }
    
    // ============================================
    // 15. إرسال رسائل
    // ============================================
    async sendMessage(sessionId, to, message, options = {}) {
        try {
            const client = this.clients.get(sessionId);
            if (!client) {
                return {
                    success: false,
                    error: 'الجلسة غير متصلة'
                };
            }
            
            // التحقق من اتصال العميل
            if (!client.info) {
                return {
                    success: false,
                    error: 'عميل WhatsApp غير جاهز'
                };
            }
            
            // إرسال الرسالة
            const result = await client.sendMessage(to, message, options);
            
            // تحديث إحصائيات الجلسة
            await this.updateSessionStats(sessionId, 'messagesSent');
            
            console.log(`✅ تم إرسال رسالة من الجلسة ${sessionId} إلى ${to}`);
            
            return {
                success: true,
                messageId: result.id._serialized,
                timestamp: result.timestamp
            };
            
        } catch (error) {
            console.error(`❌ خطأ في إرسال رسالة من الجلسة ${sessionId}:`, error);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // ============================================
    // 16. الحصول على معلومات
    // ============================================
    async getChats(sessionId, options = {}) {
        try {
            const client = this.clients.get(sessionId);
            if (!client) {
                return {
                    success: false,
                    error: 'الجلسة غير متصلة'
                };
            }
            
            // الحصول على المحادثات
            const chats = await client.getChats();
            
            // تصفية النتائج إذا طلب
            let filteredChats = chats;
            
            if (options.onlyGroups) {
                filteredChats = chats.filter(chat => chat.isGroup);
            }
            
            if (options.onlyContacts) {
                filteredChats = chats.filter(chat => !chat.isGroup && chat.isUser);
            }
            
            if (options.limit) {
                filteredChats = filteredChats.slice(0, options.limit);
            }
            
            console.log(`📋 تم الحصول على ${filteredChats.length} محادثة للجلسة ${sessionId}`);
            
            return {
                success: true,
                total: chats.length,
                filtered: filteredChats.length,
                chats: filteredChats.map(chat => ({
                    id: chat.id._serialized,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    isUser: chat.isUser,
                    isMuted: chat.isMuted,
                    isReadOnly: chat.isReadOnly,
                    unreadCount: chat.unreadCount,
                    timestamp: chat.timestamp,
                    archived: chat.archived
                }))
            };
            
        } catch (error) {
            console.error(`❌ خطأ في الحصول على المحادثات للجلسة ${sessionId}:`, error);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    // ============================================
    // 17. إغلاق الجلسات
    // ============================================
    async closeSession(sessionId) {
        console.log(`🛑 جاري إغلاق الجلسة: ${sessionId}`);
        
        try {
            const client = this.clients.get(sessionId);
            
            if (client) {
                // إغلاق العميل
                await client.destroy();
                
                // إزالة من التخزين
                this.clients.delete(sessionId);
                this.clientData.delete(sessionId);
                this.qrCodes.delete(sessionId);
                
                // تحديث حالة الجلسة في قاعدة البيانات
                await WhatsAppSession.update(
                    {
                        status: 'disconnected',
                        disconnectedAt: new Date(),
                        lastActivity: new Date()
                    },
                    { where: { id: sessionId } }
                );
                
                console.log(`✅ تم إغلاق الجلسة بنجاح: ${sessionId}`);
                
                return {
                    success: true,
                    message: 'تم إغلاق الجلسة بنجاح'
                };
            } else {
                return {
                    success: false,
                    error: 'الجلسة غير موجودة'
                };
            }
            
        } catch (error) {
            console.error(`❌ خطأ في إغلاق الجلسة ${sessionId}:`, error);
            
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    async closeAllSessions() {
        console.log('🛑 جاري إغلاق جميع الجلسات...');
        
        const results = [];
        
        for (const sessionId of this.clients.keys()) {
            const result = await this.closeSession(sessionId);
            results.push({
                sessionId,
                success: result.success,
                message: result.message || result.error
            });
        }
        
        console.log(`✅ تم إغلاق ${results.length} جلسة`);
        
        return {
            total: results.length,
            success: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            results: results
        };
    }
    
    // ============================================
    // 18. تنظيف الموارد
    // ============================================
    async cleanup() {
        console.log('🧹 جاري تنظيف موارد مدير الجلسات...');
        
        // إغلاق جميع الجلسات
        await this.closeAllSessions();
        
        // مسح جميع التخزينات المؤقتة
        this.clients.clear();
        this.clientData.clear();
        this.qrCodes.clear();
        
        console.log('✅ تم تنظيف جميع موارد مدير الجلسات');
    }
    
    // ============================================
    // 19. دوال المساعدة
    // ============================================
    getStats() {
        return {
            totalClients: this.clients.size,
            activeClients: Array.from(this.clients.values()).filter(c => c).length,
            qrCodes: this.qrCodes.size,
            memoryUsage: process.memoryUsage(),
            uptime: process.uptime()
        };
    }
    
    getSessionCount() {
        return {
            total: this.clients.size,
            connected: Array.from(this.clients.values()).filter(c => c).length,
            withQR: this.qrCodes.size
        };
    }
    
    isSessionConnected(sessionId) {
        const client = this.clients.get(sessionId);
        return !!client;
    }
    
    getSessionInfo(sessionId) {
        const client = this.clients.get(sessionId);
        const data = this.clientData.get(sessionId);
        const qrCode = this.qrCodes.get(sessionId);
        
        return {
            sessionId,
            connected: !!client,
            phoneNumber: data?.phoneNumber,
            adminId: data?.adminId,
            lastActivity: data?.lastActivity,
            hasQR: !!qrCode,
            qrAge: qrCode ? Date.now() - qrCode.timestamp : null
        };
    }
    
    // ============================================
    // 20. التصدير
    // ============================================
    getClients() {
        return this.clients;
    }
    
    getClientData() {
        return this.clientData;
    }
    
    getQRCodes() {
        return this.qrCodes;
    }
    
    getSettings() {
        return this.settings;
    }
    
    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        console.log('⚙️ تم تحديث إعدادات مدير الجلسات');
    }
}

// ============================================
// 21. تصدير الفئة
// ============================================
module.exports = WhatsAppClientManager;
