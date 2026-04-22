import { expect, test } from '@playwright/test';

type IStartupSnapshot = {
    t: number;
    bootstrap: boolean;
    splash: boolean;
    appVisible: boolean;
    workbench: boolean;
    veil: boolean;
};

declare global {
    interface Window {
        __SH_STARTUP_TRACE__?: IStartupSnapshot[];
    }
}

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const trace: IStartupSnapshot[] = [];

        const snapshot = (): void => {
            trace.push({
                t: performance.now(),
                bootstrap: Boolean(document.getElementById('bootstrap-splash')),
                splash: Boolean(document.querySelector('[data-testid="splash-screen"]')),
                appVisible: Boolean(document.querySelector('[data-testid="app-content-entry"].is-visible')),
                workbench: Boolean(document.querySelector('[data-testid="workbench-root"]')),
                veil: Boolean(document.querySelector('[data-testid="startup-veil"]')),
            });

            if (trace.length > 2_000) {
                trace.shift();
            }
        };

        window.__SH_STARTUP_TRACE__ = trace;

        document.addEventListener('DOMContentLoaded', snapshot, { once: true });

        new MutationObserver(snapshot).observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['class', 'style'],
        });

        const sample = (): void => {
            snapshot();
            if (performance.now() < 10_000) {
                window.requestAnimationFrame(sample);
            }
        };

        window.requestAnimationFrame(sample);
    });
});

test('启动流程不会出现空白帧，并完成 splash handoff', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('workbench-root')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('splash-screen')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('#bootstrap-splash')).toHaveCount(0);
    await expect(page.getByTestId('startup-veil')).toHaveCount(0);
    await expect(page.getByTestId('app-content-entry')).toHaveClass(/is-visible/);

    const trace = await page.evaluate(() => window.__SH_STARTUP_TRACE__ ?? []);

    expect(trace.length).toBeGreaterThan(0);

    const firstRelevantIndex = trace.findIndex(
        (entry) => entry.bootstrap || entry.splash || entry.appVisible || entry.workbench,
    );

    expect(firstRelevantIndex).toBeGreaterThanOrEqual(0);

    const lifecycle = trace.slice(firstRelevantIndex);

    expect(lifecycle.some((entry) => entry.bootstrap)).toBeTruthy();
    expect(lifecycle.some((entry) => entry.splash)).toBeTruthy();
    expect(lifecycle.some((entry) => entry.workbench)).toBeTruthy();

    const blankFrame = lifecycle.find(
        (entry) => !entry.bootstrap && !entry.splash && !entry.appVisible && !entry.veil,
    );

    expect(blankFrame).toBeUndefined();

    const finalSnapshot = lifecycle[lifecycle.length - 1];

    expect(finalSnapshot?.bootstrap).toBeFalsy();
    expect(finalSnapshot?.splash).toBeFalsy();
    expect(finalSnapshot?.appVisible).toBeTruthy();
});