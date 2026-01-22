/**
 * iOS 环境自动设置工具
 * 自动启动 iOS 隧道和挂载 Developer Disk Image
 */
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import path from 'node:path';
const execAsync = promisify(exec);
/**
 * 获取 go-ios 命令路径
 * 优先使用环境变量 IOS_COMMAND_PATH，否则使用 global.electronApp 或后备方案
 */
function getIOSCommandPath() {
    // 1. 优先使用环境变量（主进程已设置）
    if (process.env.IOS_COMMAND_PATH) {
        return process.env.IOS_COMMAND_PATH;
    }
    // 2. 使用 global.electronApp（主进程已设置）
    if (typeof global !== 'undefined' && global.electronApp) {
        const app = global.electronApp;
        const appPath = app.getAppPath();
        const isPackaged = app.isPackaged;
        if (isPackaged) {
            if (process.resourcesPath) {
                return path.join(process.resourcesPath, 'commands', 'ios');
            }
            else {
                const resourcesDir = path.join(path.dirname(appPath), '..', 'Resources');
                return path.join(resourcesDir, 'commands', 'ios');
            }
        }
        else {
            return path.join(appPath, 'commands', 'ios');
        }
    }
    // 3. 后备方案：使用当前工作目录
    return path.join(process.cwd(), 'commands', 'ios');
}
// 缓存挂载结果，避免多处重复挂载导致冲突
const envCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 隧道检查仍按 5 分钟缓存，用于减少命令调用
// 单独缓存 DDI 挂载结果：一次挂载后全局复用，不再重复挂载
const ddiCache = new Map();
function isCacheValid(entry) {
    if (!entry)
        return false;
    const age = Date.now() - entry.lastChecked;
    return age < CACHE_TTL_MS && entry.status.ddi;
}
export function resetIOSEnvironmentCache(udid) {
    if (udid) {
        envCache.delete(udid);
        ddiCache.delete(udid);
    }
    else {
        envCache.clear();
        ddiCache.clear();
    }
}
/**
 * 确保 Developer Disk Image 只挂载一次（全局复用）
 */
async function ensureDeveloperImageMounted(udid) {
    const cacheEntry = ddiCache.get(udid);
    // 已经确认挂载，直接复用
    if (cacheEntry?.mounted) {
        return true;
    }
    // 正在挂载，等待结果
    if (cacheEntry?.inFlight) {
        return cacheEntry.inFlight;
    }
    // 创建新的挂载流程
    const mountPromise = (async () => {
        // 先检查当前状态，避免重复挂载
        const alreadyMounted = await checkDeveloperImageMounted(udid);
        if (alreadyMounted) {
            console.log(`[iOSSetup] ✅ Developer Disk Image already mounted (global cache)`);
            ddiCache.set(udid, { mounted: true });
            return true;
        }
        const mounted = await mountDeveloperImage(udid);
        ddiCache.set(udid, { mounted });
        return mounted;
    })();
    ddiCache.set(udid, { mounted: cacheEntry?.mounted ?? false, inFlight: mountPromise });
    // 等待结果并清理 inFlight
    try {
        const result = await mountPromise;
        const entry = ddiCache.get(udid);
        if (entry) {
            entry.inFlight = undefined;
            entry.mounted = result;
            ddiCache.set(udid, entry);
        }
        return result;
    }
    catch (error) {
        const entry = ddiCache.get(udid);
        if (entry) {
            entry.inFlight = undefined;
            ddiCache.set(udid, entry);
        }
        throw error;
    }
}
/**
 * 检查 iOS 隧道是否正在运行
 */
export async function checkTunnelStatus(udid) {
    try {
        const iosPath = getIOSCommandPath();
        const { stdout } = await execAsync(`"${iosPath}" tunnel ls --udid=${udid} 2>&1`);
        const output = stdout.trim();
        if (output && !output.includes('no tunnel') && !output.includes('not running')) {
            return true;
        }
        return false;
    }
    catch (error) {
        // 如果命令失败，认为隧道未运行
        return false;
    }
}
/**
 * 启动 iOS 隧道
 */
export async function startTunnel(udid) {
    return new Promise((resolve) => {
        const iosPath = getIOSCommandPath();
        const projectRoot = process.env.IOS_COMMAND_PATH || (typeof global !== 'undefined' && global.electronApp && global.electronApp.isPackaged)
            ? path.dirname(path.dirname(iosPath)) // Resources 目录
            : process.cwd();
        console.log(`[iOSSetup] Starting iOS tunnel for device: ${udid}`);
        console.log(`[iOSSetup] Using iOS command: ${iosPath}, cwd: ${projectRoot}`);
        const proc = spawn('sh', ['-c', `ENABLE_GO_IOS_AGENT=user "${iosPath}" tunnel start --userspace --udid=${udid}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: projectRoot,
            detached: false
        });
        let stdout = '';
        let stderr = '';
        let tunnelStarted = false;
        let startupTimeout = null;
        // 设置超时：如果 10 秒内没有检测到启动信号，认为可能已经启动或失败
        startupTimeout = setTimeout(() => {
            if (!tunnelStarted) {
                console.log(`[iOSSetup] ⚠️  Tunnel startup timeout, assuming it's running or already started`);
                tunnelStarted = true;
                resolve(true);
            }
        }, 10000);
        proc.stdout?.on('data', (data) => {
            const output = data.toString();
            stdout += output;
            // 检测启动成功的信号
            if (!tunnelStarted && (output.includes('Tunnel server started') ||
                output.includes('start tunnel') ||
                output.includes('connect to lockdown tunnel'))) {
                tunnelStarted = true;
                if (startupTimeout) {
                    clearTimeout(startupTimeout);
                    startupTimeout = null;
                }
                console.log(`[iOSSetup] ✅ iOS tunnel started successfully`);
                setTimeout(() => {
                    resolve(true);
                }, 2000); // 等待 2 秒让隧道稳定
            }
        });
        proc.stderr?.on('data', (data) => {
            const output = data.toString();
            stderr += output;
            // 检测启动成功的信号（从 stderr 也可能输出）
            if (!tunnelStarted && (output.includes('Tunnel server started') ||
                output.includes('start tunnel') ||
                output.includes('connect to lockdown tunnel') ||
                (output.includes('Go-iOS Agent') && output.includes('ready')))) {
                tunnelStarted = true;
                if (startupTimeout) {
                    clearTimeout(startupTimeout);
                    startupTimeout = null;
                }
                console.log(`[iOSSetup] ✅ iOS tunnel started successfully`);
                setTimeout(() => {
                    resolve(true);
                }, 2000); // 等待 2 秒让隧道稳定
            }
        });
        proc.on('error', (error) => {
            console.error(`[iOSSetup] Tunnel process error:`, error);
            if (startupTimeout) {
                clearTimeout(startupTimeout);
                startupTimeout = null;
            }
            resolve(false);
        });
        proc.on('exit', (code) => {
            if (startupTimeout) {
                clearTimeout(startupTimeout);
                startupTimeout = null;
            }
            if (!tunnelStarted) {
                // 如果进程退出了，说明可能有问题（正常情况下不会退出）
                console.log(`[iOSSetup] ⚠️  Tunnel process exited with code ${code} before startup detected`);
                resolve(false);
            }
        });
    });
}
/**
 * 检查 Developer Disk Image 是否已挂载
 */
export async function checkDeveloperImageMounted(udid) {
    try {
        const iosPath = getIOSCommandPath();
        const { stdout, stderr } = await execAsync(`"${iosPath}" image list --udid=${udid} 2>&1`);
        const output = (stdout + stderr).trim();
        // 检查输出中是否包含成功挂载的标识
        if (output.includes('success mounting image') ||
            output.includes('already a developer image mounted') ||
            output.includes('mounted')) {
            return true;
        }
        return false;
    }
    catch (error) {
        return false;
    }
}
/**
 * 挂载 Developer Disk Image
 */
export async function mountDeveloperImage(udid) {
    return new Promise((resolve) => {
        const iosPath = getIOSCommandPath();
        const projectRoot = process.env.IOS_COMMAND_PATH || (typeof global !== 'undefined' && global.electronApp && global.electronApp.isPackaged)
            ? path.dirname(path.dirname(iosPath)) // Resources 目录
            : process.cwd();
        console.log(`[iOSSetup] Mounting Developer Disk Image for device: ${udid}`);
        console.log(`[iOSSetup] Using iOS command: ${iosPath}, cwd: ${projectRoot}`);
        const proc = spawn(iosPath, ['image', 'auto', `--udid=${udid}`], {
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: projectRoot
        });
        let stdout = '';
        let stderr = '';
        proc.stdout?.on('data', (data) => {
            const output = data.toString();
            stdout += output;
        });
        proc.stderr?.on('data', (data) => {
            const output = data.toString();
            stderr += output;
        });
        proc.on('error', (error) => {
            console.error(`[iOSSetup] Mount process error:`, error);
            resolve(false);
        });
        proc.on('exit', (code) => {
            if (code === 0) {
                // 检查输出中是否包含成功信息
                const successMessages = [
                    'success mounting image',
                    'already a developer image mounted',
                    'mounted'
                ];
                const hasSuccess = successMessages.some(msg => stderr.toLowerCase().includes(msg) || stdout.toLowerCase().includes(msg));
                if (hasSuccess) {
                    console.log(`[iOSSetup] ✅ Developer Disk Image mounted successfully`);
                    resolve(true);
                }
                else {
                    console.log(`[iOSSetup] ⚠️  Process exited with code 0, but no success message found`);
                    resolve(false);
                }
            }
            else {
                console.error(`[iOSSetup] ❌ Mount process exited with code ${code}`);
                resolve(false);
            }
        });
    });
}
/**
 * 自动设置 iOS 环境（启动隧道和挂载 DDI）
 */
export async function setupIOSEnvironment(udid) {
    const existingEntry = envCache.get(udid);
    if (existingEntry?.inFlight) {
        console.log(`[iOSSetup] ♻️  Reusing in-flight environment setup for device: ${udid}`);
        return existingEntry.inFlight;
    }
    const result = existingEntry?.status ?? { tunnel: false, ddi: false };
    const setupPromise = (async () => {
        // 1. 检查并启动隧道
        console.log(`[iOSSetup] Checking iOS tunnel status...`);
        const tunnelRunning = await checkTunnelStatus(udid);
        if (tunnelRunning) {
            console.log(`[iOSSetup] ✅ iOS tunnel is already running`);
            result.tunnel = true;
        }
        else {
            console.log(`[iOSSetup] Starting iOS tunnel...`);
            result.tunnel = await startTunnel(udid);
            if (result.tunnel) {
                console.log(`[iOSSetup] ✅ iOS tunnel started`);
            }
            else {
                console.log(`[iOSSetup] ⚠️  Failed to start iOS tunnel (may already be running)`);
                // 即使启动失败，也继续尝试挂载（可能隧道已经在运行）
                result.tunnel = true;
            }
        }
        // 2. 检查并挂载 Developer Disk Image
        console.log(`[iOSSetup] Ensuring Developer Disk Image is mounted (global once)...`);
        result.ddi = await ensureDeveloperImageMounted(udid);
        if (result.ddi) {
            console.log(`[iOSSetup] ✅ Developer Disk Image ready (global cache)`);
        }
        else {
            console.log(`[iOSSetup] ⚠️  Failed to mount Developer Disk Image`);
        }
        return result;
    })();
    envCache.set(udid, {
        status: existingEntry?.status ?? { tunnel: false, ddi: false },
        lastChecked: Date.now(),
        inFlight: setupPromise
    });
    try {
        const finalResult = await setupPromise;
        envCache.set(udid, {
            status: finalResult,
            lastChecked: Date.now()
        });
        return finalResult;
    }
    finally {
        const entry = envCache.get(udid);
        if (entry) {
            entry.inFlight = undefined;
            envCache.set(udid, entry);
        }
    }
}
