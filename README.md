`returns-service` is a consumer of the federated `notification-service` AsyncAPI contract.

It consumes:
- repository: `https://github.com/specmatic-demo/notification-service`
- branch: `migrated_to_federated_repo`
- spec: `specs/asyncapi.yaml`

Its other dependencies continue to use the central contract repository.

Run the local validation flow from the `returns-service` repository root.

Start the service stack first:

```bash
docker compose up --build
```

This brings up:
- `returns-service` on `localhost:9012`
- RabbitMQ on `localhost:5672`
- Kafka on `localhost:5416`

Start the dependency mocks in another terminal:

```bash
docker run --rm -it \
  -v "$(pwd):/usr/src/app" \
  -v ~/.specmatic:/root/.specmatic \
  -w /usr/src/app \
  --network=host \
  specmatic/enterprise \
  mock
```

This starts mocks for:
- `order-service`
- `payment-service`
- `shipping-service`
- the `notification-service` AsyncAPI dependency

Run contract tests in a third terminal:

```bash
docker run --rm -it \
  -v "$(pwd):/usr/src/app" \
  -v ~/.specmatic:/root/.specmatic \
  -w /usr/src/app \
  --network=host \
  specmatic/enterprise \
  test
```

Send the service test report to Insights:

```bash
docker run -it \
  -v "$(pwd):/usr/src/app" \
  -v ~/.specmatic:/root/.specmatic \
  -w /usr/src/app \
  --network=host \
  specmatic/specmatic \
  send-report \
  --branch-name=main \
  --repo-name="$(gh repo view --json name -q .name)" \
  --repo-id="$(gh api 'repos/{owner}/{repo}' --jq .id)" \
  --repo-url="$(gh repo view --json url --jq .url)"
```

If you want to verify async usage coverage locally:
- run the tests while the mock is running
- stop the mock cleanly with `Ctrl+C`
- then inspect `build/reports/specmatic/async/stub/ctrf/ctrf-report.json`

The async stub CTRF report is finalized when the mock process exits.
