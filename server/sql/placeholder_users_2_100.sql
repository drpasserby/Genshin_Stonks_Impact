-- =====================================================================
-- 清空 UID 2-100 的用户相关数据，并填入 99 个占位账号
-- 生成时间：2026/9/10 23:19:49
-- 本文件由 deploy/gen-placeholder-users.mjs 生成，本地与生产使用同一份，保证账号/密码一致
-- =====================================================================

START TRANSACTION;

-- ---------- 1) 删除 UID 2-100 的用户相关数据 ----------
DELETE FROM votes WHERE user_id BETWEEN 2 AND 100;
DELETE FROM votes WHERE target_type = 'NEWS'
  AND target_id IN (SELECT id FROM (SELECT id FROM news WHERE publisher_id BETWEEN 2 AND 100) x);
DELETE FROM news_stocks WHERE news_id IN
  (SELECT id FROM (SELECT id FROM news WHERE publisher_id BETWEEN 2 AND 100) x);
DELETE FROM news WHERE publisher_id BETWEEN 2 AND 100;
DELETE FROM orders WHERE user_id BETWEEN 2 AND 100;
DELETE FROM trades WHERE user_id BETWEEN 2 AND 100;
DELETE FROM holdings WHERE user_id BETWEEN 2 AND 100;
DELETE FROM watchlists WHERE user_id BETWEEN 2 AND 100;
DELETE FROM operation_logs WHERE user_id BETWEEN 2 AND 100;
DELETE FROM device_registrations WHERE user_id BETWEEN 2 AND 100;
DELETE FROM users WHERE id BETWEEN 2 AND 100;

-- ---------- 2) 插入 99 个占位账号（role=user，初始摩拉 1000000）----------
INSERT INTO users (id, username, password_hash, nickname, role, mora, frozen_mora, status, token_version) VALUES
  (2, 'user2', '$2a$10$vicm6z/w5dt/FksswV3fh..ZoF2QBh3E/Z8IsokJfHI6EtUwNvVAe', '空位2', 'user', 1000000, 0, 1, 0),
  (3, 'user3', '$2a$10$Nzt3gz.k6bx0vsINEUnqbO3.ngPr2IMr9uCmHoTu3dKEYsQFhNvj.', '空位3', 'user', 1000000, 0, 1, 0),
  (4, 'user4', '$2a$10$AK4wITL/PHetv68eUEXxPuO1io8TBpucGA0.Te29acfpHvRrK4zba', '空位4', 'user', 1000000, 0, 1, 0),
  (5, 'user5', '$2a$10$9xSBDpHn.alDw/VKAIW7l.qqreiYOyMl5kuX7WCqK59TknIbR/5xu', '空位5', 'user', 1000000, 0, 1, 0),
  (6, 'user6', '$2a$10$lkzJxnT2BdxL6e8SXpSZFOv4qcIARbZy9ZP/8tpU3VmmeRsRJ21EC', '空位6', 'user', 1000000, 0, 1, 0),
  (7, 'user7', '$2a$10$TSDWTRxiXnHx7bZ3Evvf8.eW4OO.5r1qPb6pbboN26X3UOp3pXUEK', '空位7', 'user', 1000000, 0, 1, 0),
  (8, 'user8', '$2a$10$MjL9OTBvFFSGKfm3LklcAeTwrEY1vqchLUgsBcoJ3y6EzrT2fE5Z.', '空位8', 'user', 1000000, 0, 1, 0),
  (9, 'user9', '$2a$10$5XbaUepdsxXZ9lxzselGze.mjdE483FdZjZzHJXS.KsqDPVk29C2a', '空位9', 'user', 1000000, 0, 1, 0),
  (10, 'user10', '$2a$10$5oVQwxSdJ8fgcLWwiAsJjOGB036aQqEbCuN/pbRR1.szSj2k5kfmW', '空位10', 'user', 1000000, 0, 1, 0),
  (11, 'user11', '$2a$10$2zSrKK/rvVASV20lUI6Li.lrMZEHOkKm1CfUOT4T/myHjb5lLoQ42', '空位11', 'user', 1000000, 0, 1, 0),
  (12, 'user12', '$2a$10$K//EfW8wPX26iCZqvBhWlOCfKimivxov9phlASSlko82kmUHd1ByW', '空位12', 'user', 1000000, 0, 1, 0),
  (13, 'user13', '$2a$10$6TllMEapXQ1D87Lc3D/2NuDzXkdJvPtIciF32iALp5rEFZPKCFKdi', '空位13', 'user', 1000000, 0, 1, 0),
  (14, 'user14', '$2a$10$JcpExEPyO1UUyrzIpUdUg.XdwJED0UvF49TkqYpfVkubGj6DN0VmS', '空位14', 'user', 1000000, 0, 1, 0),
  (15, 'user15', '$2a$10$HMrd0eAPLIxUJWIicRMYu.uiAEPgw8PVbozGCldM1B4fvsLCoZ/sC', '空位15', 'user', 1000000, 0, 1, 0),
  (16, 'user16', '$2a$10$8ppkt4f60ABlUcgu7F3ub.KcNNpG/IOkrJy8uxoOevBS6uSUOSABC', '空位16', 'user', 1000000, 0, 1, 0),
  (17, 'user17', '$2a$10$vY6TWAuxX05grSgoE.TehOKozaYMgBS5yiFBCibwccvvPujTrbrJm', '空位17', 'user', 1000000, 0, 1, 0),
  (18, 'user18', '$2a$10$EsfhcVuzAmBmll3HetFZ3eZUBGRyRxXaLzvOVyU6zdGEk3ae9RrNS', '空位18', 'user', 1000000, 0, 1, 0),
  (19, 'user19', '$2a$10$vG0oXjq15xe68wMgTyP/xeY7iUBdHMq06.27wtaTtriEu6bQg75e2', '空位19', 'user', 1000000, 0, 1, 0),
  (20, 'user20', '$2a$10$vd/CKpDs6zTF10EEI5wcB./lnO4q6RXYPC6MmCSeY/7Cb1F6UL5By', '空位20', 'user', 1000000, 0, 1, 0),
  (21, 'user21', '$2a$10$rGKaok6CFvd56BhwcW4FEuyfp9qt1JmlX5fcCxPcPsB1qWMS5IAPS', '空位21', 'user', 1000000, 0, 1, 0),
  (22, 'user22', '$2a$10$Ry.OMWWlQD5U1DDq9NXeyu2VsFsPgfhTvZpnJyNYt6lRuyVrpnwI.', '空位22', 'user', 1000000, 0, 1, 0),
  (23, 'user23', '$2a$10$nCPoPfVVvJpWf06O08rjyu98DP4wg2uzsn5s4AgJPlFPwN9zd01fS', '空位23', 'user', 1000000, 0, 1, 0),
  (24, 'user24', '$2a$10$L9J6RiRRA/.a3rZnnmfr/OTMOKt5JQ4ZLVbfpjJSuKLQqUNWjLZp.', '空位24', 'user', 1000000, 0, 1, 0),
  (25, 'user25', '$2a$10$RiEgBdSRgiSCJtygICxdx..YpuhKHN.tIhnbUf70XITkjE6uCZEm.', '空位25', 'user', 1000000, 0, 1, 0),
  (26, 'user26', '$2a$10$zGSbwbs9nmeQTB31sFJpUOhDhrkx.1NOR2VmesqtMheYgtZd3k7TC', '空位26', 'user', 1000000, 0, 1, 0),
  (27, 'user27', '$2a$10$Q4YKqnh.3S/jm.FzUS8/9uDHrGp0IQTIz03ut7JyNG9vsYSjdgK9W', '空位27', 'user', 1000000, 0, 1, 0),
  (28, 'user28', '$2a$10$FGK4S4hhYm2mScwHrg6lTe/O.RcX4dA2RahM1HJqL3RfiFIriv8aK', '空位28', 'user', 1000000, 0, 1, 0),
  (29, 'user29', '$2a$10$84zzcs8tS7LPnkUfoInFcuqbvLbvfRIlldwVLCSLvl0IhbJS/JPn6', '空位29', 'user', 1000000, 0, 1, 0),
  (30, 'user30', '$2a$10$bY9M1CpDlGsuyYgXgHNkHerstRMpRRqrJxoDlTQH2bIUFqsLGfg1G', '空位30', 'user', 1000000, 0, 1, 0),
  (31, 'user31', '$2a$10$UzFaLWNjfsoBISeJvbi/Iuy.Y49BPEXLUDUe3D6KgD8XxpWvodgYK', '空位31', 'user', 1000000, 0, 1, 0),
  (32, 'user32', '$2a$10$LfPRTii6ildjJIJncYYLQeRRIQrWLm95qGi4COm.a.wWNgJ.60UNC', '空位32', 'user', 1000000, 0, 1, 0),
  (33, 'user33', '$2a$10$DF6r00ua.z2r9Ct8icMLO.LB2osmY6lWl/hZ.c.5NqjGoBShyBjbG', '空位33', 'user', 1000000, 0, 1, 0),
  (34, 'user34', '$2a$10$I7k16V9zfIR9Lb9gQQHQuuCSPw9uwKxl3W0kUfvGDTHwwUd9zs896', '空位34', 'user', 1000000, 0, 1, 0),
  (35, 'user35', '$2a$10$VHC17b5d/4GgwELlu/hLnOnsH0jlq66Cw0lTea8f1mxPS3PgT4XB2', '空位35', 'user', 1000000, 0, 1, 0),
  (36, 'user36', '$2a$10$mxUOHDvYNHckeCV/seNtLeFRh8dLG7HqGvnEimcCUNzDskmdLTRBK', '空位36', 'user', 1000000, 0, 1, 0),
  (37, 'user37', '$2a$10$ZYSPSaC/aB7BugAoUMQRTu0pes69qKatrZkYru12PohIq2vkAlKgu', '空位37', 'user', 1000000, 0, 1, 0),
  (38, 'user38', '$2a$10$xCmU2BvTFXyyUK9saa/0U.tiesyMoOCepY/kKOJ3tX2AjK5G1iZNG', '空位38', 'user', 1000000, 0, 1, 0),
  (39, 'user39', '$2a$10$kBkyzFADxuvZLs5tnF9A6ePye8t0HxkDCAw1XEm5b/DYxOj7wa0US', '空位39', 'user', 1000000, 0, 1, 0),
  (40, 'user40', '$2a$10$Ek9USfY9dYsM81ETVYurD.5QXrWtR5aoVvm1dsUpzeaHdPRuPrM66', '空位40', 'user', 1000000, 0, 1, 0),
  (41, 'user41', '$2a$10$2PPuvpvqese9bru1BU6h5OskkjF9oJHR65QWdkrDw4Y374fc3QfyK', '空位41', 'user', 1000000, 0, 1, 0),
  (42, 'user42', '$2a$10$pv3/7v6eEdyI8xYXFWyCSuCslPdMW9zWLlnBVJ6aq.7tL6jWcRXU2', '空位42', 'user', 1000000, 0, 1, 0),
  (43, 'user43', '$2a$10$3i6eaYuKK2EKSe.qIuuQ2uf5ur11J86tA9OtYnSDeEcet8qT38d8a', '空位43', 'user', 1000000, 0, 1, 0),
  (44, 'user44', '$2a$10$Yb3wMeC.8xLuAisJcjwLneBfptqMpZzgKzosFbkKnNBBHVpqkkNNO', '空位44', 'user', 1000000, 0, 1, 0),
  (45, 'user45', '$2a$10$D44s2xAomHVeoFaIR/wBl.urHybvQLEgBAHERw9Xgf7m/lPFbr9E2', '空位45', 'user', 1000000, 0, 1, 0),
  (46, 'user46', '$2a$10$mgtKvEiZ4SWuHkEsm89CseedjpBzuTzNbZQPiMT2jRGPrUYu8m8ri', '空位46', 'user', 1000000, 0, 1, 0),
  (47, 'user47', '$2a$10$Yz6dtnWoASljU03TDusxJeFAh6fETvJIq5.2SoQVJkk4oza0WZMDG', '空位47', 'user', 1000000, 0, 1, 0),
  (48, 'user48', '$2a$10$0KiUolBjO.q5tru2ci9ToOBaLdoT8niK7rhJaIXWjkoixWzPix9jy', '空位48', 'user', 1000000, 0, 1, 0),
  (49, 'user49', '$2a$10$yE7o5IM3Q19DdGPC7f0lT..fFTuMd6VrCXVoQbLLy38GXKR.HDD5i', '空位49', 'user', 1000000, 0, 1, 0),
  (50, 'user50', '$2a$10$L7M.VjaL440aXY88TYbSbu0jI7T7C0CW/EiavIWT87eIv9bAtjIaq', '空位50', 'user', 1000000, 0, 1, 0),
  (51, 'user51', '$2a$10$hUAeDHMFfgJdbE3JNiy/RO9t9.zvIQpFqukcXPmvnmZ8bpRpgJjva', '空位51', 'user', 1000000, 0, 1, 0),
  (52, 'user52', '$2a$10$rwvSOCvAapCDxwMJaPRmde2wKUbcdMysOXg0Q5XPGEpF4rcWa3ml6', '空位52', 'user', 1000000, 0, 1, 0),
  (53, 'user53', '$2a$10$S/JNjf1bHJ7a.7ue/HXIjusdHS8mu6icXMHx.Hur6D1XipgEPfmre', '空位53', 'user', 1000000, 0, 1, 0),
  (54, 'user54', '$2a$10$dqtnXhpKwdwDOXveowm3huEO385/5esutP8qiQm6FcRVGFuUX0vZO', '空位54', 'user', 1000000, 0, 1, 0),
  (55, 'user55', '$2a$10$OkIFAYGIvMRUfCw0ysLBme0TaGgZJU8/mUz4Lh8/Zyn..7fryNe5O', '空位55', 'user', 1000000, 0, 1, 0),
  (56, 'user56', '$2a$10$0xhJhv3wnwg1YQi1jyQtn.1w.MhD.TyykB0jOZxpXmAG.o7UeNb2W', '空位56', 'user', 1000000, 0, 1, 0),
  (57, 'user57', '$2a$10$uhTA.CGo8FkpVI.qcXh22.JoLj3Og2nsn71q6H5FVcktf5LrvZmFC', '空位57', 'user', 1000000, 0, 1, 0),
  (58, 'user58', '$2a$10$xKMOSUHohknW51AkN/9DvufB8K7UtuEyZ9ScGXhfTtCpSVIh1..9e', '空位58', 'user', 1000000, 0, 1, 0),
  (59, 'user59', '$2a$10$4lsGriqZHbhfn1CrDmAryuc1luj5q2zdVVOfHUDkjlUwoPro3Af7q', '空位59', 'user', 1000000, 0, 1, 0),
  (60, 'user60', '$2a$10$LDUmuuTWRa3z.fQYCQG1NuwAvpWpMBNHJ0SXBI4T5dYhZ4pgzNqjK', '空位60', 'user', 1000000, 0, 1, 0),
  (61, 'user61', '$2a$10$nMQ0weSCVvAN5IEIHRxxeudSfgGFMcqHoIs2Uxboi4vAGpCdauuUq', '空位61', 'user', 1000000, 0, 1, 0),
  (62, 'user62', '$2a$10$J9TF.WVup7cU9dUwim/jRugtYAOF4j5v/vwC9sqMLS1sMyBCiEfmS', '空位62', 'user', 1000000, 0, 1, 0),
  (63, 'user63', '$2a$10$2sZEWy8eWAqsYa79iBY82eE.c.YYP5kynKHsT/HVyngXiQ/X8ZmtG', '空位63', 'user', 1000000, 0, 1, 0),
  (64, 'user64', '$2a$10$dcH2ZiXdzO46jq8YqPKLQOIxvCZlcfjLGDwt5Fe0NZvOk7wM5y1Mq', '空位64', 'user', 1000000, 0, 1, 0),
  (65, 'user65', '$2a$10$hN23BTE9DbFS4L.1e.Gn7.MtYNJ.lwBQnRERs1SlenCy9IfT8Iw62', '空位65', 'user', 1000000, 0, 1, 0),
  (66, 'user66', '$2a$10$pS7L5iObo6ccFfcT/kjfP.emqO3ZZuoT9VlKkRYz2LcdltwYNJNpu', '空位66', 'user', 1000000, 0, 1, 0),
  (67, 'user67', '$2a$10$YRpIBVpqksx.W7g7hOKtRO.EEqazkv11drD9ux1Z/Apg31OyM5kie', '空位67', 'user', 1000000, 0, 1, 0),
  (68, 'user68', '$2a$10$AA.DfqYK9w2V9EeBKstu8ebZu7sMHMPinXeSn9.Ty/wPvyk4QpxC2', '空位68', 'user', 1000000, 0, 1, 0),
  (69, 'user69', '$2a$10$guvdT2MqTjJRPivEbAGFtewOvMmz59rArAsQJxOxhty/JPtZpJYFC', '空位69', 'user', 1000000, 0, 1, 0),
  (70, 'user70', '$2a$10$plFPWrI0ZXanAz8R66dr6e1UbZQoc5pgLKW3OcA4YB.jHftdJw3cu', '空位70', 'user', 1000000, 0, 1, 0),
  (71, 'user71', '$2a$10$tV6zZn546rm/prC9b.0Z4ek5.dM6iqWvEA4yiKhyQojvdetiLtELC', '空位71', 'user', 1000000, 0, 1, 0),
  (72, 'user72', '$2a$10$L/PLdapuqkG9uqOI3M3Xye2FAng1iVEuCGd0faHr8gl8EKP358vQC', '空位72', 'user', 1000000, 0, 1, 0),
  (73, 'user73', '$2a$10$lRygVTVpgtVvPPjocRIRheftI0cdBqQeBQ3cVuJcrRAPBvdZVVi5K', '空位73', 'user', 1000000, 0, 1, 0),
  (74, 'user74', '$2a$10$RwYB3SfdDl1V6LvflhXWauzV3p1j3/ZklBeNmJMHSeIT6fDOQHBpm', '空位74', 'user', 1000000, 0, 1, 0),
  (75, 'user75', '$2a$10$./4Q2W8183EbTP20.u5cm.V/AD80mPM7hak4Hw1WJU/W7HMHewTw.', '空位75', 'user', 1000000, 0, 1, 0),
  (76, 'user76', '$2a$10$qVtHpVTrjakfyoJKss9DMeC0/bHy44b1hQm9KFrE8f37vqTbjWu.G', '空位76', 'user', 1000000, 0, 1, 0),
  (77, 'user77', '$2a$10$1mjM/vZU2vF8aXLRJhBJt.zDO4hNCapoCco9u5SYCFhcB6hj5UkOu', '空位77', 'user', 1000000, 0, 1, 0),
  (78, 'user78', '$2a$10$1LHs.GMwU1wK.f7w1sBOp.psBXvfRiBOgBorM2A0igP6TkS3LIdJq', '空位78', 'user', 1000000, 0, 1, 0),
  (79, 'user79', '$2a$10$rXdTGNegA/aRTCOKNOyK3.X9rxw2k8dL8UfOt2CULUAOMnIqjuBHO', '空位79', 'user', 1000000, 0, 1, 0),
  (80, 'user80', '$2a$10$eMCcK2ISWifgMmJ4Qc23DOudU36S0XIR9o5FOObxbbhIfCujOGG0e', '空位80', 'user', 1000000, 0, 1, 0),
  (81, 'user81', '$2a$10$LxrZQAFbfcQoP.N30APh0OcNtn.05evThA4ywNBmsibn3P.br2l7a', '空位81', 'user', 1000000, 0, 1, 0),
  (82, 'user82', '$2a$10$.47EO4XfuAVYZNGBw1jgQ.ic8WENLbyMKOYnFv21IprO5RDwndAv2', '空位82', 'user', 1000000, 0, 1, 0),
  (83, 'user83', '$2a$10$0dAT/CPlW7ZAFXkIEO7MHuXr4ncUWbF0zt.k0v4Ay1CaaVe3vfTte', '空位83', 'user', 1000000, 0, 1, 0),
  (84, 'user84', '$2a$10$5.GbA9o9ZxhEDbhDMY8O/e.9i7g7p7mGtB6jYSRIRc3C5alqVnEEO', '空位84', 'user', 1000000, 0, 1, 0),
  (85, 'user85', '$2a$10$Rww4yTIyYgZATErn98C0x.GYG93wRjf1U22L84VMtLGCQtNNKS7.2', '空位85', 'user', 1000000, 0, 1, 0),
  (86, 'user86', '$2a$10$J.T1HldeNk8zU.WVIbNtn.MvAS9x12W6oJ23tdXLDEoEmkRL2yZMa', '空位86', 'user', 1000000, 0, 1, 0),
  (87, 'user87', '$2a$10$BH8KurjooamjipDOjLDqdekaRZ5BDeHOABuoSLkSm13AmgcWUMzxy', '空位87', 'user', 1000000, 0, 1, 0),
  (88, 'user88', '$2a$10$DyRdbAL27XrioGEEP4Qm9.j2uIgTTpl5E8wclOaoPHZ.oPwgjzUyq', '空位88', 'user', 1000000, 0, 1, 0),
  (89, 'user89', '$2a$10$bACQuFjA8nF4.dOh1Y8XduY2bezomY5lEYX.vm8UoJHmmn2RLtTwG', '空位89', 'user', 1000000, 0, 1, 0),
  (90, 'user90', '$2a$10$Ny4rx0rzMw9VoGX7oR5YROF1Re6pkQpYw6LZQJ9GqlfQ4VseffuJa', '空位90', 'user', 1000000, 0, 1, 0),
  (91, 'user91', '$2a$10$dR4h9SA.r0z/OQ/rC7OsVOaPPR9t/22hpSe16uwQSvAn95aoz8v1W', '空位91', 'user', 1000000, 0, 1, 0),
  (92, 'user92', '$2a$10$Lgn/ZTMyQ1KHowQMXyrT3e1Ii/X08U4Na0J50cRFEbhU.iOJrfMbi', '空位92', 'user', 1000000, 0, 1, 0),
  (93, 'user93', '$2a$10$k4bRw5S7tFuUXT9eSyDWueZmN9YWIcBHJhGMxU2lHMbyWpiIUhH8G', '空位93', 'user', 1000000, 0, 1, 0),
  (94, 'user94', '$2a$10$blRLSsvJH7pRBMvBKTIhseB5Sf4YgMs3Tp5XbsdckQtUtQyG.WTO.', '空位94', 'user', 1000000, 0, 1, 0),
  (95, 'user95', '$2a$10$0KQMZ4m9y.KH1E4pXOHUmuWg/9mhI3kWKPqBcfs7DpCHOa0RYk2wi', '空位95', 'user', 1000000, 0, 1, 0),
  (96, 'user96', '$2a$10$M.sdqrhV7yYG3WClAeDM7.sLiVFXtbpefYTZasBlp0ZQInWTcsAcO', '空位96', 'user', 1000000, 0, 1, 0),
  (97, 'user97', '$2a$10$U7PpeDmFkUUVTDz69AxRLObUDs97ZN9hc7Fx3j5tRHFZXffdJOQX2', '空位97', 'user', 1000000, 0, 1, 0),
  (98, 'user98', '$2a$10$hItSLg2o9u/6POK9tl37u.fHt46r5AktQX1G4fJN20cOdpt9kEIqW', '空位98', 'user', 1000000, 0, 1, 0),
  (99, 'user99', '$2a$10$wwDdbzw.N36fqWfsfQ0Jo.zHG/Jiji/exompFlGM5IESPVnjIP5qW', '空位99', 'user', 1000000, 0, 1, 0),
  (100, 'user100', '$2a$10$0.v/e.Uj4giiLQSvRVnD1.GWJBKGKHyNsspjQGy0HGDSkPOFChyje', '空位100', 'user', 1000000, 0, 1, 0);

COMMIT;

-- ---------- 校验 ----------
SELECT COUNT(*) AS placeholder_users FROM users WHERE id BETWEEN 2 AND 100;
SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM users WHERE id BETWEEN 2 AND 100;
SELECT id, username, nickname, role, status, mora FROM users ORDER BY id LIMIT 5;
