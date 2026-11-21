import assert from 'node:assert/strict';
import test from 'node:test';
import { renderUnreadDivider, unreadDividerText } from '../openteamily/static/chat/app.mjs';

// Just enough DOM for the divider: the list carries one <li> per message, each
// tagged with its message id the way renderSocialMessages tags a real row.
function fakeList(messageIds) {
  const children = messageIds.map(id => ({dataset: {messageId: id}, tagName: 'li'}));
  return {
    children,
    insertBefore(node, reference) {
      const at = reference ? children.indexOf(reference) : children.length;
      assert.notEqual(at, -1, 'the divider must be inserted before a rendered row');
      children.splice(at, 0, node);
    },
    removeChild(node) {
      const at = children.indexOf(node);
      assert.notEqual(at, -1, 'the stale divider must be a child of the list');
      children.splice(at, 1);
    },
  };
}

const document = {
  createElement(tagName) {
    return {tagName, className: '', textContent: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; }};
  },
};

const corners = list => list.children.map(node => (node.className === 'unread-divider' ? '|' : node.dataset.messageId));

test('a conversation with no unread messages draws no divider', () => {
  const list = fakeList(['m1', 'm2', 'm3']);
  assert.equal(renderUnreadDivider(document, list, null), null);
  assert.equal(renderUnreadDivider(document, list, {messageId: '', count: 0}), null);
  assert.deepEqual(corners(list), ['m1', 'm2', 'm3']);
});

test('the divider sits right above the first unread message', () => {
  const list = fakeList(['m1', 'm2', 'm3']);
  const divider = renderUnreadDivider(document, list, {messageId: 'm2', count: 3});
  assert.ok(divider, 'a conversation with unread messages draws the divider');
  assert.deepEqual(corners(list), ['m1', '|', 'm2', 'm3']);
  assert.equal(divider.tagName, 'li');
  assert.equal(divider.className, 'unread-divider');
  assert.equal(divider.attributes.role, 'separator');
});

test('the divider says 以下是新消息 and counts the messages below it', () => {
  assert.equal(unreadDividerText(3), '以下是新消息 · 3 条');
  assert.equal(unreadDividerText(1), '以下是新消息 · 1 条');
  assert.equal(unreadDividerText(0), '以下是新消息');
  const list = fakeList(['m1', 'm2']);
  const divider = renderUnreadDivider(document, list, {messageId: 'm2', count: 3});
  assert.equal(divider.textContent, '以下是新消息 · 3 条');
});

test('a boundary outside the loaded window draws nothing, not a wrong line', () => {
  const list = fakeList(['m2', 'm3']);
  assert.equal(renderUnreadDivider(document, list, {messageId: 'm1', count: 2}), null);
  assert.deepEqual(corners(list), ['m2', 'm3']);
});

test('repainting the same conversation keeps exactly one divider', () => {
  const boundary = {messageId: 'm2', count: 1};
  const list = fakeList(['m1', 'm2']);
  renderUnreadDivider(document, list, boundary);
  renderUnreadDivider(document, list, boundary);
  assert.deepEqual(corners(list), ['m1', '|', 'm2']);
  // Leaving the conversation and coming back rebuilds the list, so the divider
  // is drawn once from the new snapshot rather than accumulating.
  const reopened = fakeList(['m1', 'm2']);
  renderUnreadDivider(document, reopened, boundary);
  assert.deepEqual(corners(reopened), ['m1', '|', 'm2']);
});
