import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFramework, purposeBlock, inheritedPurpose } from './framework.mjs';

const doc = `# 项目
## 时间日志
<!--node {"id":"tl","type":"timeline"}-->
### 母栏
<!--node {"id":"mother","kind":"info"}-->

**目的（做这里的人先读）**

- 问题：要回答什么。
- 要交：四项。

别的段落。

#### 子栏
<!--node {"id":"child","kind":"info","summary":"子栏摘要没写目的"}-->

只有一句话。

##### 孙栏
<!--node {"id":"grand","kind":"info"}-->

#### 另一个子栏
<!--node {"id":"own","kind":"info"}-->

**目的**

- 自己的目的。
`;

test('purposeBlock 只取目的标题和紧跟的列表', () => {
  const { byId } = parseFramework(doc);
  const text = purposeBlock(byId.get('mother').body);
  assert.match(text, /要回答什么/);
  assert.match(text, /要交：四项/);
  assert.doesNotMatch(text, /别的段落/);
});

test('子栏和孙栏没写目的时，取最近上级栏的目的', () => {
  const { byId } = parseFramework(doc);
  assert.equal(inheritedPurpose(byId.get('child')).from, '母栏');
  assert.equal(inheritedPurpose(byId.get('grand')).from, '母栏');
  assert.match(inheritedPurpose(byId.get('grand')).text, /要回答什么/);
});

test('自己写了目的就用自己的，不再往上取', () => {
  const { byId } = parseFramework(doc);
  const own = inheritedPurpose(byId.get('own'));
  assert.equal(own.from, null);
  assert.match(own.text, /自己的目的/);
});

test('上级都没写目的时返回 null', () => {
  const { byId } = parseFramework('# 项目\n## 日志\n<!--node {"id":"tl","type":"timeline"}-->\n### 栏\n<!--node {"id":"a","kind":"info"}-->\n\n正文。\n');
  assert.equal(inheritedPurpose(byId.get('a')), null);
});

import { logicOutline } from './framework.mjs';

test('逻辑部分的标题和摘要由程序给时间日志里的步骤；节点本身在逻辑部分里时不重复', () => {
  const text = `# 项目
## 研究理解
<!--node {"id":"lg","type":"logic"}-->
### 主线
<!--node {"id":"main","kind":"info","summary":"主线一句话"}-->
#### 子论点
<!--node {"id":"sub","kind":"info","summary":"子论点一句话"}-->
## 日志
<!--node {"id":"tl","type":"timeline"}-->
### 步骤所在栏
<!--node {"id":"step-node","kind":"info"}-->
`;
  const parsed = parseFramework(text);
  const { byId } = parsed;
  const out = logicOutline(parsed, byId.get('step-node'));
  assert.match(out, /主线：主线一句话/);
  assert.match(out, /  - 子论点：子论点一句话/);
  assert.equal(logicOutline(parsed, byId.get('sub')), '');
});
