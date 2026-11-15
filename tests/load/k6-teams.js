import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    discovery_board_load: {
      executor: 'constant-vus',
      vus: 100,
      duration: '15s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const page = ((__VU + __ITER) % 5) + 1;
  const res = http.get(`${BASE_URL}/api/teams?page=${page}&limit=20&openOnly=true`);
  check(res, {
    'status is 200': (r) => r.status === 200,
    'returns teams array': (r) => Array.isArray(r.json('teams')),
  });
  sleep(0.1);
}
