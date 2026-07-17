import assert from "node:assert/strict";
import test from "node:test";
import { runPhase } from "./command-runner.mjs";

test("阶段命令顺序执行", () => {
  const calls = [];
  const spawn = (executable, args) => {
    calls.push([executable, args]);
    return { status: 0 };
  };
  const status = runPhase(
    {
      commands: {
        test: [
          { executable: "python", args: ["-m", "pytest"] },
          { executable: "npm", args: ["--prefix", "web", "test"] },
        ],
      },
    },
    "test",
    { spawn },
  );
  assert.equal(status, 0);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["python", "npm"],
  );
});

test("首个失败后停止并传播退出码", () => {
  const calls = [];
  const spawn = (executable) => {
    calls.push(executable);
    return { status: executable === "python" ? 7 : 0 };
  };
  const status = runPhase(
    {
      commands: {
        lint: [
          { executable: "python", args: ["-m", "ruff"] },
          { executable: "npm", args: ["run", "lint"] },
        ],
      },
    },
    "lint",
    { spawn },
  );
  assert.equal(status, 7);
  assert.deepEqual(calls, ["python"]);
});

test("未知阶段返回配置错误", () => {
  assert.throws(() => runPhase({ commands: {} }, "missing"), /未知命令阶段/);
});
