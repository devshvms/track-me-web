import assert from 'node:assert';
import { resolvePosthogDashboard } from '../public/admin/posthog-state.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
    try {
        fn();
        passed += 1;
        process.stdout.write(`  ✓ ${name}\n`);
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
        process.stdout.write(`  ✗ ${name}\n`);
    }
}

test('missing and blank values remain unconfigured', () => {
    assert.deepEqual(resolvePosthogDashboard(null), { kind: 'missing', url: null });
    assert.deepEqual(resolvePosthogDashboard('   '), { kind: 'missing', url: null });
});

test('malformed and unsafe values are invalid', () => {
    assert.deepEqual(resolvePosthogDashboard('not a URL'), { kind: 'invalid', url: null });
    assert.deepEqual(resolvePosthogDashboard('javascript:alert(1)'), { kind: 'invalid', url: null });
});

test('authenticated project dashboards are external-only', () => {
    assert.deepEqual(
        resolvePosthogDashboard('https://eu.posthog.com/project/222002/dashboard/861668'),
        {
            kind: 'external',
            url: 'https://eu.posthog.com/project/222002/dashboard/861668'
        }
    );
});

test('public shared dashboards are embeddable', () => {
    assert.deepEqual(
        resolvePosthogDashboard('https://eu.posthog.com/shared/test-token'),
        {
            kind: 'embedded',
            url: 'https://eu.posthog.com/shared/test-token'
        }
    );
    assert.equal(
        resolvePosthogDashboard('https://posthog.example/shared_dashboard/test-token').kind,
        'embedded'
    );
});

process.stdout.write(`\nposthog state: ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
    failures.forEach((failure) => process.stderr.write(`  FAIL ${failure}\n`));
    process.exit(1);
}
