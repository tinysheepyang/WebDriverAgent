/**
 * 内存缓存实现
 */
export class MemoryCache {
    constructor(defaultTTL = 10 * 60 * 1000) {
        this.cache = new Map();
        // 默认 10 分钟
        this.defaultTTL = defaultTTL;
    }
    /**
     * 设置缓存
     */
    set(key, data, ttl) {
        const entry = {
            data,
            timestamp: Date.now(),
            ttl: ttl || this.defaultTTL
        };
        this.cache.set(key, entry);
    }
    /**
     * 获取缓存
     */
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            return null;
        }
        // 检查是否过期
        if (Date.now() - entry.timestamp > entry.ttl) {
            this.cache.delete(key);
            return null;
        }
        return entry.data;
    }
    /**
     * 删除缓存
     */
    delete(key) {
        this.cache.delete(key);
    }
    /**
     * 清空缓存
     */
    clear() {
        this.cache.clear();
    }
    /**
     * 清理过期缓存
     */
    cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > entry.ttl) {
                this.cache.delete(key);
            }
        }
    }
}
