import { test, expect } from "bun:test";
import { withSdkStartupDeadline, SdkStartupTimeout, sdkStartupTimeoutMs } from "../lib/sdk-startup-deadline";
const delay = (ms:number) => new Promise(r=>setTimeout(r,ms));
test("stalled startup closes child and rejects", async()=>{
 let closed=0;
 const source={async *[Symbol.asyncIterator](){await delay(50);yield {type:"system"};},close(){closed++;}};
 await expect((async()=>{for await(const _ of withSdkStartupDeadline(source,5)) {}})()).rejects.toBeInstanceOf(SdkStartupTimeout);
 expect(closed).toBe(1);
});
test("init events do not extend deadline",async()=>{
 let closed=0;
 const source={async *[Symbol.asyncIterator](){yield {type:"system"};await delay(50);yield {type:"system"};},close(){closed++;}};
 await expect((async()=>{for await(const _ of withSdkStartupDeadline(source,5)) {}})()).rejects.toBeInstanceOf(SdkStartupTimeout);
 expect(closed).toBe(1);
});
test("first assistant removes deadline for long tools; close on completion",async()=>{
 let closed=0; const seen:string[]=[];
 const source={async *[Symbol.asyncIterator](){yield {type:"assistant"};await delay(30);yield {type:"result"};},close(){closed++;}};
 for await(const m of withSdkStartupDeadline(source,5))seen.push(m.type);
 expect(seen).toEqual(["assistant","result"]);expect(closed).toBe(1);
});
test("consumer break closes child",async()=>{
 let closed=0;
 const source={async *[Symbol.asyncIterator](){yield {type:"assistant"};},close(){closed++;}};
 for await(const _ of withSdkStartupDeadline(source,5))break;
 expect(closed).toBe(1);
});
test("configuration bounded",()=>{
 for(const v of [undefined,"0","NaN","-1","600001"])expect(sdkStartupTimeoutMs(v)).toBe(180000);
 expect(sdkStartupTimeoutMs("30000")).toBe(30000);
});
