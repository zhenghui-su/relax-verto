# Verto React Demo

这个 demo 使用父目录中的 @relax/verto 本地包，演示最小通话流程：

- 签入和签出 FreeSWITCH Verto
- 使用浏览器麦克风手动呼出
- 挂断当前呼叫
- 监听来电并接听或拒接
- 将远端音频轨道绑定到 audio 元素
- 挂断后生成一份 WAV 本地录音，并支持下载

## 运行

先在仓库根目录构建库：

    pnpm run build

再安装并启动 demo：

    cd demo
    pnpm install
    pnpm run dev

页面使用根目录 index.html 的轻量测试台风格，桌面端把 Verto 配置和呼叫控制放在同一行，移动端自动堆叠。WSS、登录域、STUN、用户名、密码和目标号码都可以在页面输入，并保存到浏览器 localStorage。密码以明文保存在当前浏览器的站点存储中，请只在可信任的设备上使用此演示。浏览器首次签入时会请求麦克风权限。

通话开始后，demo 会使用浏览器的 MediaRecorder 同时录制本地麦克风和远端音频，挂断后解码并编码为标准 PCM WAV。录音会显示在播放器下方，下一通电话开始时会覆盖上一通录音。WAV 文件比压缩格式大。录音能力依赖浏览器支持 MediaRecorder、AudioContext 和音频解码。

本地依赖在 demo/package.json 中声明为 file:..。如果根目录源码发生变化，重新执行根目录 pnpm run build，Vite demo 会读取最新的 dist 构建产物。
