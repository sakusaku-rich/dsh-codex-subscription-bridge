import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectBridge } from '../lib/direct.js';
import { AuthStore } from '../lib/auth.js';
import { BridgeError } from '../lib/errors.js';

/** A store that counts preparation calls instead of preparing anything. */
function countingStore() {
  const calls = { value: 0 };
  const store = new AuthStore('/unused-synthetic-path');
  store.prepare = async () => { calls.value += 1; };
  return { store, calls };
}

/** A bridge whose token seam parks each call until a finisher resolves it. */
function parkedBridge() {
  const finishers = [];
  const live = { value: 0 };
  const peak = { value: 0 };
  const bridge = new DirectBridge({ token: async () => {
    live.value += 1;
    peak.value = Math.max(peak.value, live.value);
    await new Promise((resolve) => finishers.push(resolve));
    live.value -= 1;
    throw new BridgeError('ABORTED');
  } });
  return { bridge, finishers, live, peak };
}

/** Four admitted calls, each with its own caller signal. */
function admittedCalls(bridge) {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const codes = controllers.map((controller) => bridge.listModels(controller.signal).catch((error) => error.code));
  return { controllers, codes };
}

test('pre-aborted discovery reports ABORTED for every request', async () => {
  const { store } = countingStore();
  const bridge = new DirectBridge(store);
  const controller = new AbortController();
  controller.abort();

  const results = await Promise.allSettled(Array.from({ length: 32 }, () => bridge.listModels(controller.signal)));

  assert.equal(results.every((value) => value.reason?.code === 'ABORTED'), true);

  await bridge.close();
});

test('pre-aborted discovery never enters store preparation', async () => {
  const { store, calls } = countingStore();
  const bridge = new DirectBridge(store);
  const controller = new AbortController();
  controller.abort();

  await Promise.allSettled(Array.from({ length: 32 }, () => bridge.listModels(controller.signal)));

  assert.equal(calls.value, 0);

  await bridge.close();
});

test('pre-aborted authentication reports ABORTED', async () => {
  const { store } = countingStore();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(store.token(controller.signal), { code: 'ABORTED' });
});

test('pre-aborted authentication never reaches the network', async () => {
  const { store, calls } = countingStore();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(store.token(controller.signal), { code: 'ABORTED' });

  assert.equal(calls.value, 0);
});

test('aborted in-flight authentication stays live until its seam settles', async () => {
  const { bridge, finishers, live } = parkedBridge();
  const { controllers, codes } = admittedCalls(bridge);

  await new Promise((resolve) => setImmediate(resolve));
  controllers.forEach((controller) => controller.abort());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(live.value, 4);

  finishers.forEach((resolve) => resolve());
  await Promise.all(codes);
  await bridge.close();
});

test('aborted in-flight authentication keeps its capacity slot until it settles', async () => {
  const { bridge, finishers } = parkedBridge();
  const { controllers, codes } = admittedCalls(bridge);

  await new Promise((resolve) => setImmediate(resolve));
  controllers.forEach((controller) => controller.abort());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(bridge.active.size, 4);

  finishers.forEach((resolve) => resolve());
  await Promise.all(codes);
  await bridge.close();
});

test('new requests are refused with LIMIT_EXCEEDED while aborted work holds capacity', async () => {
  const { bridge, finishers } = parkedBridge();
  const { controllers, codes } = admittedCalls(bridge);

  await new Promise((resolve) => setImmediate(resolve));
  controllers.forEach((controller) => controller.abort());
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = await Promise.all(Array.from({ length: 32 }, () => bridge.listModels(new AbortController().signal).catch((error) => error.code)));

  assert.equal(rejected.every((code) => code === 'LIMIT_EXCEEDED'), true);

  finishers.forEach((resolve) => resolve());
  await Promise.all(codes);
  await bridge.close();
});

test('the concurrency peak stays at the admitted count', async () => {
  const { bridge, finishers, peak } = parkedBridge();
  const { controllers, codes } = admittedCalls(bridge);

  await new Promise((resolve) => setImmediate(resolve));
  controllers.forEach((controller) => controller.abort());
  await Promise.all(Array.from({ length: 32 }, () => bridge.listModels(new AbortController().signal).catch((error) => error.code)));

  assert.equal(peak.value, 4);

  finishers.forEach((resolve) => resolve());
  await Promise.all(codes);
  await bridge.close();
});

test('capacity is released once the aborted work settles', async () => {
  const { bridge, finishers } = parkedBridge();
  const { controllers, codes } = admittedCalls(bridge);

  await new Promise((resolve) => setImmediate(resolve));
  controllers.forEach((controller) => controller.abort());
  await Promise.all(Array.from({ length: 32 }, () => bridge.listModels(new AbortController().signal).catch((error) => error.code)));
  finishers.forEach((resolve) => resolve());
  await Promise.all(codes);

  assert.equal(bridge.active.size, 0);

  await bridge.close();
});
