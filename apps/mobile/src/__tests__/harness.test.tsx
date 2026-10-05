/**
 * Harness smoke test (plan 004 M2). Two jobs: prove jest-expo + RNTL render
 * React Native components, and prove every shared package resolves through the
 * workspace under jest's resolver — the same class of failure Metro hit with
 * NodeNext `.js` specifiers.
 */
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { CytaleApiClient } from '@cytale/api-client';
import { GatewayClient } from '@cytale/gateway-client';
import { GATEWAY_VERSION, isKnownOp, makeSnowflake } from '@cytale/protocol';
import { defaultStore } from '@cytale/state';

describe('mobile test harness', () => {
  it('renders React Native primitives under jest-expo', async () => {
    // RNTL v14's render is async (React 19 concurrent); `screen` populates
    // only after it resolves.
    await render(<Text>harness</Text>);
    expect(screen.getByText('harness')).toBeTruthy();
  });

  it('resolves every shared workspace package', () => {
    expect(typeof GATEWAY_VERSION).toBe('number');
    expect(isKnownOp(0)).toBe(true);
    expect(makeSnowflake('1756920000000000000')).toBe('1756920000000000000');
    expect(typeof GatewayClient).toBe('function');
    expect(typeof CytaleApiClient).toBe('function');
    expect(defaultStore).toBeDefined();
  });
});
