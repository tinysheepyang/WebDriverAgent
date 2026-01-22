/**
 * 资源列表管理
 *
 * 核心改变：使用 assetId，移除 folder/name
 */
export class AssetsManager {
    constructor(photosService) {
        this.photosService = photosService;
    }
    /**
     * 获取所有资源列表（不分相册）
     *
     * 这是 Phase 1 的核心接口，替代 DCIM 目录遍历
     *
     * @param limit 每页数量
     * @param offset 偏移量
     * @returns 资源列表响应（包含总数和当前页数据）
     */
    async getAllAssets(limit, offset) {
        const available = await this.photosService.isAvailable();
        if (!available) {
            console.log('[AssetsManager] Photos Service not available');
            return { total: 0, items: [] };
        }
        try {
            // 通过 Bridge Service 获取资源列表
            const response = await this.photosService.getAllAssets(limit, offset);
            console.log(`[AssetsManager] ✅ Got ${response.items.length} assets (total: ${response.total})`);
            return response;
        }
        catch (error) {
            console.error('[AssetsManager] Failed to get assets:', error);
            return { total: 0, items: [] };
        }
    }
    /**
     * 获取相册中的资源列表（已废弃，Phase 1 不使用相册）
     * @deprecated 使用 getAllAssets 代替
     */
    async getAssets(albumId) {
        console.warn('[AssetsManager] getAssets(albumId) is deprecated, use getAllAssets instead');
        return [];
    }
}
