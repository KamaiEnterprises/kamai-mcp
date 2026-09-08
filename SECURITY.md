# Security policy

Report a vulnerability in this server to **contact@kamai.io** with "security" in
the subject. Do not open a public issue for it.

Include what you found, how to reproduce it, and what you think the impact is.
You will get an acknowledgement within five business days.

The server verifies bearer tokens against Kamai's authorization server and
forwards them to Kamai's MCP API. It stores nothing. Anything about the Kamai
platform itself rather than this code goes to the same address.
