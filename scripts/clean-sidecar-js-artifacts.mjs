#!/usr/bin/env node
// @ts-check

/**
 * Remove committed compiled `.js` artifacts that shadow their `.ts` sources
 * under `agent-sidecar/src/`, and make sure they can never sneak back in.
 *
 * Why these files are safe to delete (none of them is used at runtime):
 * - agent-sidecar/tsconfig.json sets "noEmit": true -> tsc never emits them
 * - build is esbuild -> dist/ (node build.mjs)
 * - start runs the bundle (node dist/server.js)
 * - dev runs the TS directly (tsx src/server.ts)
 * - tests only match the TypeScript .spec.ts files (node --test)
 *
 * Safe by construction: a `.js` is removed ONLY when a sibling `.ts` exists,
 * so hand-written JavaScript (if any is ever added) is left untouched.
 *
 * Usage:
 * node scripts/clean-sidecar-js-artifacts.mjs # do it
 * node scripts/clean-sidecar-js-artifacts.mjs --dry-run # preview only
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");

// Repo root = top of the git working tree, so the script works from anywhere.
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	encoding: "utf8",
}).trim();

const srcDir = join(repoRoot, "agent-sidecar", "src");

if (!existsSync(srcDir)) {
	console.error(
		`error: ${relative(repoRoot, srcDir)} not found - run this inside the calamex repo.`,
	);
	process.exit(1);
}

/**
 * Recursively collect every *.js that has a sibling *.ts.
 * @param {string} dir
 * @returns {string[]}
 */
function collectArtifacts(dir) {
	/** @type {string[]} */
	const found = [];

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);

		if (entry.isDirectory()) {
			found.push(...collectArtifacts(full));
		} else if (entry.isFile() && entry.name.endsWith(".js")) {
			const tsSibling = `${full.slice(0, -3)}.ts`;
			if (existsSync(tsSibling)) found.push(full);
		}
	}

	return found;
}

const artifacts = collectArtifacts(srcDir).sort();

if (artifacts.length === 0) {
	console.log("\u2713 No .js artifacts found - working tree is already clean.");
} else {
	console.log(
		`Found ${artifacts.length} compiled .js artifact(s) shadowing .ts sources:`,
	);
	for (const file of artifacts) console.log(`  ${relative(repoRoot, file)}`);

	if (DRY_RUN) {
		console.log("\n--dry-run: nothing was deleted.");
	} else {
		const relPaths = artifacts.map((file) => relative(repoRoot, file));

		// Remove from both the index and the working tree in a single call.
		execFileSync("git", ["rm", "--quiet", "--", ...relPaths], {
			cwd: repoRoot,
			stdio: "inherit",
		});

		console.log(`\n\u2713 Removed ${artifacts.length} file(s) from git.`);
	}
}

// Ensure the ignore rule is present so these never get re-committed.
const gitignorePath = join(repoRoot, ".gitignore");
const rule = "agent-sidecar/src/**/*.js";
const current = existsSync(gitignorePath)
	? readFileSync(gitignorePath, "utf8")
	: "";
const hasRule = current.split(/\r?\n/).some((line) => line.trim() === rule);

if (hasRule) {
	console.log(`\u2713 .gitignore already ignores: ${rule}`);
} else if (DRY_RUN) {
	console.log(`--dry-run: would add ignore rule to .gitignore: ${rule}`);
} else {
	const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";

	appendFileSync(
		gitignorePath,
		`${prefix}\n# Compiled JS artifacts that shadow .ts sources (never used at runtime)\n${rule}\n`,
	);

	execFileSync("git", ["add", ".gitignore"], {
		cwd: repoRoot,
		stdio: "inherit",
	});

	console.log(`\u2713 Added ignore rule to .gitignore: ${rule}`);
}

if (!DRY_RUN) {
	console.log(
		"\nAll staged. Review with `git status`, then commit, e.g.:\n" +
		'  git commit -m "chore(agent-sidecar): drop committed JS build artifacts from src"',
	);
}