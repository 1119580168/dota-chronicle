const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
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
async function ps(script, timeout = 25000) {
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
