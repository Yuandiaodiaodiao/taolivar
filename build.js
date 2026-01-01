import { spawn } from "child_process";

const bunPath = "C:\\Users\\Yuan\\.bun\\bin\\bun.exe";
const args = ["build", "src/arbitrageLive.js", "--compile", "--outfile", "dist/variational-sdk.exe"];

const proc = spawn("cmd.exe", ["/c", bunPath, ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
});

proc.on("close", (code) => {
  if (code === 0) {
    console.log("Build successful: dist/variational-sdk.exe");
  } else {
    console.error("Build failed with code:", code);
    process.exit(code);
  }
});
