/* 直接问 D3D11 / DXGI：这台机器到底有没有可用的硬件 3D。
   WebView2 的合成器依赖它，起不来就整屏不画。 */
const koffi = require('koffi');
const d3d11 = koffi.load('d3d11.dll');
const dxgi = koffi.load('dxgi.dll');
const user32 = koffi.load('user32.dll');

const D3D11CreateDevice = d3d11.func('long D3D11CreateDevice(void *adapter, int driverType, void *software, uint32 flags, void *pFeatureLevels, uint32 featureLevels, uint32 sdkVersion, _Out_ void **ppDevice, _Out_ int *pFeatureLevel, _Out_ void **ppContext)');
const CreateDXGIFactory1 = dxgi.func('long CreateDXGIFactory1(void *riid, _Out_ void **ppFactory)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int i)');

const hr = (v) => '0x' + (v >>> 0).toString(16) + ' (' + v + ')';

for (const [name, type] of [['HARDWARE', 1], ['WARP', 5], ['REFERENCE', 3]]) {
    const dev = [null], fl = [0], ctx = [null];
    const r = D3D11CreateDevice(null, type, null, 0, null, 0, 7, dev, fl, ctx);
    console.log(`D3D11 ${name}: hr=${hr(r)} featureLevel=0x${(fl[0] >>> 0).toString(16)}`);
}

console.log('SM_CXSCREEN', GetSystemMetrics(0), 'SM_CYSCREEN', GetSystemMetrics(1));
console.log('SM_CMONITORS', GetSystemMetrics(80));
console.log('SM_XVIRTUALSCREEN', GetSystemMetrics(76), 'SM_YVIRTUALSCREEN', GetSystemMetrics(77),
    'SM_CXVIRTUALSCREEN', GetSystemMetrics(78), 'SM_CYVIRTUALSCREEN', GetSystemMetrics(79));

// DXGI 适配器描述
const buf = Buffer.alloc(16);
// IID_IDXGIFactory1 = {770aae78-f26f-4dba-a829-253c83d1b387}
const iid = Buffer.from('78ae0a77' + '6ff2' + 'ba4d' + 'a829' + '253c83d1b387', 'hex');
const fac = [null];
const r2 = CreateDXGIFactory1(iid, fac);
console.log('CreateDXGIFactory1 hr=' + hr(r2));
