const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const fs = require("node:fs/promises");
const f = require("./files.cjs");
const execute = promisify(execFile);
const psExe = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
// A parent PowerShell 7 process can export incompatible PSModulePath entries.
const psEnv = {
  ...process.env,
  PSModulePath: [
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/Modules",
    ),
    path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "WindowsPowerShell/Modules",
    ),
  ].join(";"),
};
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
async function runPs(script, timeout = 25000, ownScript = false) {
  const text =
    "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " +
    script;
  try {
    const { stdout } = await execute(
      psExe,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        ...(ownScript ? ["-ExecutionPolicy", "Bypass"] : []),
        "-EncodedCommand",
        Buffer.from(text, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024, env: psEnv },
    );
    return stdout.trim().replace(/^\uFEFF/, "");
  } catch (e) {
    const detail = String(e.stderr || "").replace(/_x000D__x000A_/g, "\n");
    const errors = [...detail.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(
      (m) =>
        m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
    );
    const first = (errors[0] || detail.split("\n")[0] || "操作超时或执行失败")
      .trim()
      .slice(0, 350);
    throw Error("Windows 操作失败：" + first);
  }
}
async function ps(script, timeout = 25000) {
  return runPs(script, timeout);
}
async function fillServerBots(clientRoot, stateDirectory, expected) {
  const appRoot = path.resolve(__dirname, "../..");
  const script = path.join(
    appRoot.endsWith(".asar") ? appRoot + ".unpacked" : appRoot,
    "resources/server/manage-standard-server.ps1",
  );
  if (
    !expected ||
    !Number.isInteger(expected.pid) ||
    expected.pid <= 0 ||
    typeof expected.exe !== "string" ||
    !path.isAbsolute(expected.exe) ||
    expected.exe.includes("\0") ||
    typeof expected.createdUtc !== "string" ||
    !Number.isFinite(Date.parse(expected.createdUtc))
  )
    throw Error("专服进程身份无效，拒绝补充 Bot");
  for (const directory of [clientRoot, stateDirectory]) {
    if (
      typeof directory !== "string" ||
      !path.isAbsolute(directory) ||
      directory.includes("\0")
    )
      throw Error("专服管理目录必须使用实际绝对路径");
    await f.noLinks(directory);
  }
  await f.noLinks(script);
  if (!(await fs.stat(script)).isFile())
    throw Error("本程序专服管理脚本不可用，请重新完整解压启动器");
  const command =
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${expected.pid}"; ` +
    `if(-not $p -or $p.ExecutablePath -ne ${literal(expected.exe)} -or [Math]::Abs(($p.CreationDate.ToUniversalTime()-[DateTime]::Parse(${literal(expected.createdUtc)}).ToUniversalTime()).TotalSeconds) -ge 1.5){throw '专服进程身份已变化，拒绝补充 Bot'}; ` +
    `& ${literal(script)} -ClientRoot ${literal(clientRoot)} -StateDirectory ${literal(stateDirectory)} -Action FillBots`;
  try {
    return await runPs(command, 25000, true);
  } catch (e) {
    throw Error(
      `补充 Bot 失败：${e.message}。请检查专服会话日志及是否仍在选人阶段；若组织策略禁止脚本，请联系管理员。`,
    );
  }
}
async function processes() {
  const raw = await ps(
    "Get-CimInstance Win32_Process -Filter \"Name='dota.exe' OR Name='dota2.exe' OR Name='hl2.exe' OR Name='steam.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name=\"CreatedUtc\";Expression={$_.CreationDate.ToUniversalTime().ToString(\"o\")}} | ConvertTo-Json -Compress",
  );
  return raw ? [].concat(JSON.parse(raw)) : [];
}
async function identity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw Error("Invalid PID");
  const raw = await ps(
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name="CreatedUtc";Expression={$_.CreationDate.ToUniversalTime().ToString("o")}} | ConvertTo-Json -Compress`,
  );
  return raw ? JSON.parse(raw) : null;
}
function sameProcess(row, expected) {
  return (
    !!row &&
    row.ProcessId === expected.pid &&
    String(row.ExecutablePath).toLowerCase() === expected.exe.toLowerCase() &&
    Math.abs(Date.parse(row.CreatedUtc) - Date.parse(expected.createdUtc)) <
      1500
  );
}
async function stopOwned(p) {
  // Recheck inside the same PowerShell process immediately before stopping.
  await ps(
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${p.pid}"; if($p){if($p.ExecutablePath -ne ${literal(p.exe)} -or [Math]::Abs(($p.CreationDate.ToUniversalTime()-[DateTime]::Parse(${literal(p.createdUtc)}).ToUniversalTime()).TotalSeconds) -gt 1.5){throw '进程身份已变化，拒绝停止'}; Stop-Process -Id ${p.pid} -ErrorAction Stop}`,
  );
}
async function portFree(port) {
  const raw = await ps(
    `if(@(Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue).Count -or @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue).Count){'busy'}else{'free'}`,
  );
  if (raw !== "free") throw Error(`端口 ${port} 已被占用，请选择其他端口`);
}
const key = "HKCU:\\Software\\Valve\\Steam\\ActiveProcess";
async function registryRead(name) {
  const raw = await ps(
    `$k=Get-Item -LiteralPath ${literal(key)}; if($k.GetValueNames() -contains ${literal(name)}){@{exists=$true;value=$k.GetValue(${literal(name)},$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$k.GetValueKind(${literal(name)}).ToString()}|ConvertTo-Json -Compress}else{@{exists=$false}|ConvertTo-Json -Compress}`,
  );
  return JSON.parse(raw);
}
async function registryWrite(name, value) {
  if (!["SteamClientDll", "SteamClientDll64"].includes(name))
    throw Error("Invalid Steam registry value");
  const open = `$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Valve\\Steam\\ActiveProcess',$true);if(-not $k){throw 'Steam 注册表项不可写'};`;
  if (value.exists)
    await ps(
      open +
        `try{$k.SetValue(${literal(name)},${literal(value.value)},[Microsoft.Win32.RegistryValueKind]::${value.kind === "ExpandString" ? "ExpandString" : "String"})}finally{$k.Close()}`,
    );
  else
    await ps(
      open + `try{$k.DeleteValue(${literal(name)},$false)}finally{$k.Close()}`,
    );
}
async function steamDll(source2) {
  const raw = await ps(
    `$paths=@(); Get-CimInstance Win32_Process -Filter "Name='steam.exe'" | ForEach-Object {if($_.ExecutablePath){$paths+=Split-Path $_.ExecutablePath}}; $paths+=(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath; $paths+=Join-Path \${env:ProgramFiles(x86)} 'Steam'; foreach($s in ($paths|Select-Object -Unique)){if(-not $s){continue};$d=Join-Path $s '${source2 ? "steamclient64.dll" : "steamclient.dll"}';if(Test-Path -LiteralPath $d){$sig=Get-AuthenticodeSignature -LiteralPath $d;if($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'Valve'){Write-Output $d;return}}};throw '未找到签名有效的官方 Steam DLL，请修复或安装 Steam'`,
  );
  return raw;
}
async function diskSpace(root) {
  const drive = path.parse(root).root.slice(0, 2);
  const raw = await ps(
    `Get-CimInstance Win32_LogicalDisk -Filter ${literal("DeviceID='" + drive + "'")} | Select-Object DeviceID,FreeSpace,Size | ConvertTo-Json -Compress`,
  );
  return raw ? JSON.parse(raw) : null;
}
module.exports = {
  ps,
  fillServerBots,
  psExe,
  psEnv,
  literal,
  processes,
  identity,
  sameProcess,
  stopOwned,
  portFree,
  registryRead,
  registryWrite,
  steamDll,
  diskSpace,
};
