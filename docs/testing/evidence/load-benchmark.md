# Load benchmark

Generated 2026-09-10T22:55:02.149Z · 40 participants · 200 receipts (10% duplicates) + 40 status messages · 4 worker loops · simulated extractor and transport (platform cost only, no OCR, no WhatsApp).

| Metric | Value |
|---|---|
| Processing wall time | 21110 ms |
| Throughput | 11.4 events/s (9.5 receipts/s) |
| Inbound → processed p50 / p95 / max | 9142 / 16916 / 17655 ms (includes queue wait) |
| Intake → decision p50 / p95 / max | 10161 / 16697 / 17316 ms |
| Entries / canonical receipts / distinct receipts sent | 180 / 180 / 180 |
| Exactly-once | **yes** |
| Dead events / failed events / dead jobs | 0 / 0 / 0 |
| Outbox by status | {"sent":920} |

Queue depth samples (ms since enqueue → pending events / jobs / outbox): 625:236/4/4, 1129:232/8/8, 1635:225/15/15, 2135:220/20/20, 2639:216/24/24, 3142:208/32/32, 3640:204/36/36, 4141:196/44/44, 4646:192/48/48, 5159:187/53/53, 5646:180/60/60, 6144:176/64/64, 6652:168/72/72, 7151:164/76/76, 7650:156/84/84, 8159:152/88/88, 8655:145/95/95, 9154:140/100/100, 9658:135/105/105, 10158:128/112/112, 10663:124/116/116, 11157:116/124/124, 11672:112/128/128, 12167:104/136/136, 12668:100/140/140, 13174:94/146/146, 13668:88/152/152, 14180:84/156/156, 14682:76/164/164, 15186:72/169/169, 15690:64/176/176, 16187:60/180/180, 16683:53/188/188, 17194:48/192/192, 17687:44/196/196, 18197:40/168/228, 18685:40/132/264, 19185:40/97/300, 19683:40/61/336, 20188:40/26/371, 20682:40/0/330, 21183:0/0/31
