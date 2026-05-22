/**
 * Tests for extra-usage detection helpers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isExtraUsageRequiredMessage } from "../src/index.ts";

describe("isExtraUsageRequiredMessage", () => {
	it("detects Claude Code extra-usage rate-limit text", () => {
		assert.equal(isExtraUsageRequiredMessage("Fast mode requires extra usage billing — /extra-usage to enable"), true);
		assert.equal(isExtraUsageRequiredMessage({ message: "Extra usage is required for 1M context" }), true);
		assert.equal(isExtraUsageRequiredMessage(new Error("overage not provisioned")), true);
	});

	it("ignores normal rate-limit text", () => {
		assert.equal(isExtraUsageRequiredMessage("Claude rate limited; resets at 12:00"), false);
	});
});
