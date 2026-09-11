# BIG Network Deploy Gate Playbook (for automatic agent cycles)

This file is the full instruction set for the deploy-gate step of the
"_BIG Network Snapshot Refresh" workflow. Read it top to bottom and execute.

## Step 1 — Test the gate
Attempt to create the Runpod network volume with the Runpod MCP tool
`create_network_volume`:
- name: `bigchain-ledger`
- size: 10 GB
- dataCenter: `US-CA-2`
- type: `STANDARD`

## Step 2 — If it fails with the $5 minimum-balance error
("You must have at least $5 in your account to create a network volume")
the gate is still closed. Reply with exactly:
`DEPLOY GATE: still closed`
and stop. Do NOT message MC, do NOT create events, do NOT report anywhere.
The gate check runs again next cycle.

## Step 3 — If the volume creation SUCCEEDS
The balance has cleared. Execute the full deploy now:

1. Upload `/app/conversations/69f56989777455158d4472f4/bigchain-state.zip`
   with `upload_private_file`, then `create_file_signed_url` with a long
   expiry (e.g. 86400s) to get STATE_URL.
2. Create the validator pod with Runpod MCP `create_pod`:
   - name: `BIG-NETWORK-VALIDATOR-01`
   - cloud: SECURE
   - cpu: `{ "id": "cpu3m", "vcpuCount": 2 }`
   - containerDiskInGb: 20
   - image: `runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404`
   - ports: `8899/http`, `9090/http`, `22/tcp`
   - args: `bash -c "curl -fsSL https://raw.githubusercontent.com/mcontwitter-glitch/BIG-Network/main/pod-boot.sh | bash"`
   - networkVolumes: [ the volume id from step 3 ]
   - env: `STATE_URL` = signed URL, `VOLUME_PATH` = `/workspace/bigchain`
   - dataCenterIds: `["US-CA-2"]`
3. Wait for the pod to reach RUNNING (poll `get_pod`); grab the proxy URLs
   for 8899 (RPC) and 9090 (gateway).
4. Verify: HTTP GET the RPC URL (a Solana RPC 405/200 response counts as live)
   and the gateway URL.
5. Update the briefing note (`/app/notes/for-you/main.md`) BIG Network section
   with the live endpoints + pod id, and clear the "blocked on Runpod top-up"
   line.
6. DM MC (Telegram chat 5919724185) the live endpoints.
7. Archive the 'BIG Network Deploy Gate' workflow with manage_workflow
   (action='archive') so it stops firing — its purpose is fulfilled.
8. Reply with the endpoints.

## Notes
- The deploy kit details live in
  `/app/conversations/69f56989777455158d4472f4/big-network/docs/POD-SPEC.md`.
- If a step fails unexpectedly, reply with a one-line error summary
  (mention pod id if created).
