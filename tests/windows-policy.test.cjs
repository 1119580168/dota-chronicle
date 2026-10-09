const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const windowsFile = path.resolve(__dirname, "../src/backend/windows.cjs");
async function mockedWindows(executeCall, extra = {}) {
  const exec = () => {};
  exec[promisify.custom] = executeCall;
  const context = {
    require: (name) =>
      name === "node:child_process"
        ? { execFile: exec }
        : name === "node:fs/promises"
          ? { stat: async () => ({ isFile: () => true }) }
          : name === "./files.cjs"
            ? { noLinks: async () => {} }
            : require(name),
    module: { exports: {} },
    Buffer,
    process,
    __dirname: path.dirname(windowsFile),
    ...extra,
  };
  vm.runInNewContext(await fs.readFile(windowsFile, "utf8"), context, {
    filename: windowsFile,
  });
  return context.module.exports;
}
const expected = {
  pid: 1234,
  exe: path.resolve("fixture/dota2.exe"),
  createdUtc: "2026-10-09T00:00:00.000Z",
};
test("only the fixed bundled Bot script uses process Bypass, with quoted arguments and an identity recheck", async () => {
  const calls = [],
    windows = await mockedWindows(async (...args) => {
      calls.push(args);
      return { stdout: "fixture result" };
    });
  const clientRoot = path.resolve("client ' dollar $()"),
    stateDirectory = path.resolve("private ' state");
  await windows.ps("Get-ExecutionPolicy");
  assert.equal(calls[0][1].includes("-ExecutionPolicy"), false);
  await windows.fillServerBots(clientRoot, stateDirectory, expected);
  const [exe, args, options] = calls[1];
  assert.equal(exe, windows.psExe);
  assert.equal(args[args.indexOf("-ExecutionPolicy") + 1], "Bypass");
  const command = Buffer.from(
    args[args.indexOf("-EncodedCommand") + 1],
    "base64",
  ).toString("utf16le");
  assert.ok(
    command.includes(
      windows.literal(
        path.resolve(
          path.dirname(windowsFile),
          "../../resources/server/manage-standard-server.ps1",
        ),
      ),
    ),
  );
  assert.ok(command.includes("-ClientRoot " + windows.literal(clientRoot)));
  assert.ok(
    command.includes("-StateDirectory " + windows.literal(stateDirectory)),
  );
  assert.ok(command.indexOf("Get-CimInstance") < command.indexOf("& "));
  assert.match(command, /ExecutablePath.*CreationDate/);
  assert.equal(command.includes("Set-ExecutionPolicy"), false);
  assert.equal(options.windowsHide, true);
});
test("invalid Bot management paths and identities are rejected before creating a PowerShell process", async () => {
  let calls = 0;
  const windows = await mockedWindows(async () => {
    calls++;
    return { stdout: "" };
  });
  for (const identity of [
    null,
    { ...expected, pid: -1 },
    { ...expected, exe: "relative.exe" },
    { ...expected, createdUtc: "invalid" },
  ])
    await assert.rejects(
      windows.fillServerBots(
        path.resolve("client"),
        path.resolve("state"),
        identity,
      ),
      /身份无效/,
    );
  await assert.rejects(
    windows.fillServerBots("relative", path.resolve("state"), expected),
    /实际绝对路径/,
  );
  assert.equal(calls, 0);
});
test("packaged Bot management resolves the physical ASAR unpacked script", async () => {
  const packagedRoot = path.resolve("package/resources/app.asar"),
    calls = [];
  const windows = await mockedWindows(
    async (...args) => {
      calls.push(args);
      return { stdout: "" };
    },
    {
      __dirname: path.join(packagedRoot, "src/backend"),
    },
  );
  await windows.fillServerBots(
    path.resolve("client"),
    path.resolve("state"),
    expected,
  );
  const args = calls[0][1],
    command = Buffer.from(
      args[args.indexOf("-EncodedCommand") + 1],
      "base64",
    ).toString("utf16le");
  assert.ok(
    command.includes(
      windows.literal(
        path.join(
          packagedRoot + ".unpacked",
          "resources/server/manage-standard-server.ps1",
        ),
      ),
    ),
  );
  assert.equal(
    command.includes(
      windows.literal(
        path.join(packagedRoot, "resources/server/manage-standard-server.ps1"),
      ),
    ),
    false,
  );
});
test("Bot management failure includes the operation and actionable session guidance", async () => {
  const windows = await mockedWindows(async () => {
    throw { stderr: "fixture policy refusal" };
  });
  await assert.rejects(
    windows.fillServerBots(
      path.resolve("client"),
      path.resolve("state"),
      expected,
    ),
    /补充 Bot 失败.*fixture policy refusal.*会话日志.*组织策略/,
  );
});
test(
  "real Windows Restricted policy blocks an ordinary PS1 but permits the scoped bundled helper without changing its parent",
  {
    skip: process.platform !== "win32",
    timeout: 60000,
  },
  async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "chronicle-policy-"));
    t.after(async () => {
      assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(base).startsWith("chronicle-policy-"));
      await fs.rm(base, { recursive: true, force: true });
    });
    const script = path.join(
      base,
      "resources/server/manage-standard-server.ps1",
    );
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(
      script,
      "param([string]$ClientRoot,[string]$StateDirectory,[string]$Action)\n@{policy=(Get-ExecutionPolicy).ToString();client=$ClientRoot;state=$StateDirectory;action=$Action}|ConvertTo-Json -Compress\n",
    );
    const probe = path.join(base, "probe.cjs"),
      clientRoot = path.join(base, "中文 client ' dollar $()"),
      stateDirectory = path.join(base, "状态 state ' directory");
    await fs.mkdir(clientRoot);
    await fs.mkdir(stateDirectory);
    await fs.writeFile(
      probe,
      `
const fs=require('node:fs'), Module=require('node:module'), path=require('node:path');
const original=${JSON.stringify(windowsFile)}, base=${JSON.stringify(base)};
const mod=new Module(path.join(base,'src/backend/windows.cjs'),module);
mod.filename=path.join(base,'src/backend/windows.cjs');
mod.paths=module.paths;
mod.require=(name)=>name==='./files.cjs'?require(path.join(path.dirname(original),'files.cjs')):require(name);
mod._compile(fs.readFileSync(original,'utf8'),mod.filename);
const w=mod.exports;
(async()=>{
 const before=await w.ps('Get-ExecutionPolicy');
 let ordinaryBlocked=false;
 try{await w.ps('& '+w.literal(${JSON.stringify(script)}));}catch(e){ordinaryBlocked=true;}
 const row=await w.identity(process.pid);
 const expected={pid:row.ProcessId,exe:row.ExecutablePath,createdUtc:row.CreatedUtc};
 const result=JSON.parse(await w.fillServerBots(${JSON.stringify(clientRoot)},${JSON.stringify(stateDirectory)},expected));
 const after=await w.ps('Get-ExecutionPolicy');
 let mismatchBlocked=false;
 try{await w.fillServerBots(${JSON.stringify(clientRoot)},${JSON.stringify(stateDirectory)},{...expected,createdUtc:'2000-01-01T00:00:00.000Z'});}catch(e){mismatchBlocked=/身份已变化/.test(e.message);}
 console.log(JSON.stringify({before,ordinaryBlocked,result,after,mismatchBlocked}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
`,
    );
    const { stdout } = await execute(process.execPath, [probe], {
      env: { ...process.env, PSExecutionPolicyPreference: "Restricted" },
      windowsHide: true,
      timeout: 55000,
    });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.before, "Restricted");
    assert.equal(result.ordinaryBlocked, true);
    assert.equal(result.result.policy, "Bypass");
    assert.equal(result.result.client, clientRoot);
    assert.equal(result.result.state, stateDirectory);
    assert.equal(result.result.action, "FillBots");
    assert.equal(result.after, "Restricted");
    assert.equal(result.mismatchBlocked, true);
  },
);
