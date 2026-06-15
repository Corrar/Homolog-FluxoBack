// src/controllers/requests.controller.ts

import { Request, Response } from 'express';
import { pool } from '../db';
import { createLog } from '../utils/logger';
import { getClientIp } from '../utils/ip';
import { sendPushNotificationToRole } from '../utils/notifications';
import { validatePositiveItems } from '../middlewares/validators';

export const getRequests = async (req: Request, res: Response) => {
  try {
    const query = `
      WITH FilteredRequests AS (
          SELECT * FROM requests 
          WHERE status IN ('aberto', 'aprovado') OR created_at >= NOW() - INTERVAL '30 days'
          ORDER BY created_at DESC LIMIT 200
      )
      SELECT r.*, 
          cs.op_code,
          json_build_object('name', p.name, 'sector', p.sector) as requester,
          COALESCE(ri_agg.items, '[]'::json) as request_items
      FROM FilteredRequests r
      LEFT JOIN profiles p ON r.requester_id = p.id
      LEFT JOIN client_services cs ON r.client_service_id = cs.id
      LEFT JOIN (
          SELECT ri.request_id, json_agg(
              json_build_object(
                'id', ri.id, 
                'quantity_requested', ri.quantity_requested, 
                'quantity_delivered', ri.quantity_delivered, 
                'quantity_returned', ri.quantity_returned, 
                'custom_product_name', ri.custom_product_name, 
                'observation', ri.observation, 
                'client_service', ri.client_service, 
                'products', CASE WHEN pr.id IS NOT NULL THEN json_build_object('name', pr.name, 'sku', pr.sku, 'unit', pr.unit, 'tags', pr.tags, 'unit_price', pr.unit_price) ELSE NULL END
              )
          ) as items
          FROM request_items ri LEFT JOIN products pr ON ri.product_id = pr.id
          WHERE ri.request_id IN (SELECT id FROM FilteredRequests) GROUP BY ri.request_id
      ) ri_agg ON ri_agg.request_id = r.id ORDER BY r.created_at DESC;
    `;
    const { rows } = await pool.query(query);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar solicitações' }); }
};

export const getMyRequests = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  try {
    const query = `
      WITH FilteredRequests AS (
          SELECT * FROM requests 
          WHERE requester_id = $1 AND (status IN ('aberto', 'aprovado') OR created_at >= NOW() - INTERVAL '30 days')
          ORDER BY created_at DESC LIMIT 200
      )
      SELECT r.*, 
          cs.op_code, 
          COALESCE(ri_agg.items, '[]'::json) as request_items
      FROM FilteredRequests r
      LEFT JOIN client_services cs ON r.client_service_id = cs.id
      LEFT JOIN (
          SELECT ri.request_id, json_agg(
              json_build_object(
                'id', ri.id, 
                'quantity_requested', ri.quantity_requested, 
                'quantity_delivered', ri.quantity_delivered, 
                'quantity_returned', ri.quantity_returned, 
                'custom_product_name', ri.custom_product_name, 
                'observation', ri.observation, 
                'client_service', ri.client_service, 
                'products', CASE WHEN pr.id IS NOT NULL THEN json_build_object('name', pr.name, 'sku', pr.sku, 'unit', pr.unit, 'tags', pr.tags, 'unit_price', pr.unit_price) ELSE NULL END
              )
          ) as items
          FROM request_items ri LEFT JOIN products pr ON ri.product_id = pr.id
          WHERE ri.request_id IN (SELECT id FROM FilteredRequests) GROUP BY ri.request_id
      ) ri_agg ON ri_agg.request_id = r.id ORDER BY r.created_at DESC;
    `;
    const { rows } = await pool.query(query, [userId]);
    res.json(rows);
  } catch (error: any) { res.status(500).json({ error: 'Erro ao buscar minhas solicitações' }); }
};

export const createRequest = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { sector, items, op_code } = req.body; 
  const client = await pool.connect();
  
  try {
    validatePositiveItems(items);
    await client.query('BEGIN');

    // =========================================================================
    // 🛡️ 1. REGRA DE NEGÓCIO: VERIFICA SE A OP É OBRIGATÓRIA (BASEADO EM TAGS)
    // =========================================================================
    let requiresOp = false;
    const exemptTags = ['camisetas', 'camiseta', 'epi', 'ferramentas', 'insumos', 'insumo'];
    
    const productIds = items
      .map((i: any) => i.product_id)
      .filter((id: any) => id && id !== 'custom');

    if (items.length > productIds.length) {
        requiresOp = true;
    } else if (productIds.length > 0) {
        const productsQuery = await client.query(
            'SELECT id, tags FROM products WHERE id = ANY($1::uuid[])', 
            [productIds]
        );
        
        for (const product of productsQuery.rows) {
            let tags: string[] = [];
            
            if (Array.isArray(product.tags)) {
                tags.push(...product.tags.map((t: string) => String(t).trim().toLowerCase()));
            } else if (typeof product.tags === 'string' && product.tags.trim() !== '') {
                try {
                    const parsed = JSON.parse(product.tags);
                    if (Array.isArray(parsed)) tags.push(...parsed.map((t: string) => String(t).trim().toLowerCase()));
                    else tags.push(product.tags.trim().toLowerCase());
                } catch(e) {
                    tags.push(product.tags.trim().toLowerCase());
                }
            }

            const isExempt = tags.some((tag: string) => exemptTags.includes(tag));
            
            if (!isExempt) {
                requiresOp = true;
                break;
            }
        }
    }

    // =========================================================================
    // 🛡️ 2. VALIDAÇÃO E VÍNCULO DA OP
    // =========================================================================
    let client_service_id = null;

    if (op_code) {
        const opCheck = await client.query('SELECT id, status FROM client_services WHERE op_code = $1', [op_code]);
        if (opCheck.rows.length === 0) throw new Error("OP_NAO_ENCONTRADA");
        
        const opStatus = opCheck.rows[0].status;
        if (opStatus === 'finalizada' || opStatus === 'encerrada') throw new Error("OP_FINALIZADA");
        
        client_service_id = opCheck.rows[0].id;
    } else if (requiresOp) {
        throw new Error("OP_OBRIGATORIA_TAGS");
    }

    // =========================================================================
    // 🟢 3. INSERÇÃO DO PEDIDO BASE
    // =========================================================================
    const reqRes = await client.query(
      'INSERT INTO requests (requester_id, sector, status, client_service_id) VALUES ($1, $2, $3, $4) RETURNING id', 
      [userId, sector, 'aberto', client_service_id]
    );
    const requestId = reqRes.rows[0].id;
    
    const sortedItems = [...items].sort((a, b) => {
       if (!a.product_id) return 1; if (!b.product_id) return -1;
       return String(a.product_id).localeCompare(String(b.product_id));
    });

    // =========================================================================
    // 🌉 4. A PONTE MÁGICA: RESERVA NORMAL OU ENVIO PARA O KANBAN 3D
    // =========================================================================
    for (const item of sortedItems) {
      const isCustom = item.product_id === 'custom' || !item.product_id;
      const productId = isCustom ? null : item.product_id;
      const customName = isCustom ? item.custom_name : null;
      const priority = item.priority || 'Média'; 
      let is3D = false;

      if (productId) {
        const productCheck = await client.query(
            `SELECT p.is_3d, (COALESCE(s.quantity_on_hand, 0) - COALESCE(s.quantity_reserved, 0)) as available 
             FROM products p LEFT JOIN stock s ON p.id = s.product_id 
             WHERE p.id = $1 FOR UPDATE OF p`, 
            [productId]
        );
        
        const available = parseFloat(productCheck.rows[0]?.available || 0);
        is3D = productCheck.rows[0]?.is_3d || false;

        if (is3D) {
            let missingQty = item.quantity;
            let reservedQty = 0;

            if (available > 0) {
                reservedQty = Math.min(item.quantity, available);
                missingQty = item.quantity - reservedQty;
                
                await client.query(
                  `UPDATE stock SET quantity_reserved = COALESCE(quantity_reserved, 0) + $1 WHERE product_id = $2`, 
                  [reservedQty, productId]
                );
            }

            if (missingQty > 0) {
                const kanbanOpNumber = op_code ? op_code : 'Interno';
                const notesInfo = `⚠️ RESUMO DO PEDIDO:\n- A Produzir: ${missingQty} un.\n- Já em Estoque: ${reservedQty} un.\n- Total Solicitado: ${item.quantity} un.\n\n📝 OBSERVAÇÕES:\n${item.observation || 'Nenhuma'}`;

                await client.query(
                   `INSERT INTO demands_3d (product_id, request_id, quantity, op_number, priority, notes) 
                    VALUES ($1, $2, $3, $4, $5, $6)`,
                   [productId, requestId, missingQty, kanbanOpNumber, priority, notesInfo]
                );
            }
        } 
        else {
            if (available < item.quantity) throw new Error(`Estoque disponível insuficiente para o produto ID: ${productId}`);
            await client.query(`UPDATE stock SET quantity_reserved = COALESCE(quantity_reserved, 0) + $1 WHERE product_id = $2`, [item.quantity, productId]);
        }
      }
      
      await client.query(
        'INSERT INTO request_items (request_id, product_id, custom_product_name, quantity_requested, observation, client_service) VALUES ($1, $2, $3, $4, $5, $6)', 
        [requestId, productId, customName, item.quantity, item.observation || null, item.client_service || null]
      );
    }
    
    await createLog(userId, 'CRIAR_SOLICITACAO', { id_solicitacao: requestId, setor: sector, total_itens: items.length }, getClientIp(req), client);
    await client.query('COMMIT');

    const fullReqQuery = `
      SELECT r.*, 
             cs.op_code, 
             json_build_object('name', p.name, 'sector', p.sector) as requester, 
             (SELECT COALESCE(json_agg(json_build_object('id', ri.id, 'quantity_requested', ri.quantity_requested, 'quantity_delivered', ri.quantity_delivered, 'quantity_returned', ri.quantity_returned, 'custom_product_name', ri.custom_product_name, 'observation', ri.observation, 'client_service', ri.client_service, 'products', CASE WHEN pr.id IS NOT NULL THEN json_build_object('name', pr.name, 'sku', pr.sku, 'unit', pr.unit, 'tags', pr.tags) ELSE NULL END)), '[]'::json) FROM request_items ri LEFT JOIN products pr ON ri.product_id = pr.id WHERE ri.request_id = r.id) as request_items 
      FROM requests r 
      LEFT JOIN profiles p ON r.requester_id = p.id 
      LEFT JOIN client_services cs ON r.client_service_id = cs.id 
      WHERE r.id = $1`;
    const { rows: fullReqRows } = await client.query(fullReqQuery, [requestId]);
    
    if ((req as any).io) {
        const notificationData = { id: `req-${requestId}-${Date.now()}`, message: `📢 Nova solicitação do setor: ${sector}`, action: 'Ver Pedidos', type: 'solicitacao' };
        (req as any).io.to(['almoxarife', 'admin', 'escritorio']).emit('new_request_notification', notificationData);
        (req as any).io.to(['almoxarife', 'admin', 'escritorio']).emit('new_request', fullReqRows[0]);
        
        const changedProducts = sortedItems.map(item => item.product_id).filter(id => id && id !== 'custom');
        if (changedProducts.length > 0) {
            (req as any).io.emit('stock_updated', { changedProducts }); 
        }
    }

    const dataAtual = new Date();
    const dataFormatada = dataAtual.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const horaFormatada = dataAtual.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

    let listaMateriais = '';
    const itemsDetail = fullReqRows[0].request_items || [];
    
    itemsDetail.forEach((reqItem: any) => {
        const qtd = reqItem.quantity_requested;
        const nomeProduto = reqItem.products ? reqItem.products.name : (reqItem.custom_product_name || 'Produto Genérico');
        const skuProduto = reqItem.products?.sku ? `SKU: ${reqItem.products.sku}` : 'SKU: N/A';
        listaMateriais += `\n- ${qtd} un. ${nomeProduto} | ${skuProduto}`;
    });

    const nomeSolicitante = fullReqRows[0].requester?.name || 'Usuário';
    const avisoOp = op_code ? `\nOP: ${op_code}` : `\nOP: Isento (EPI/Ferramenta/Insumo)`;
    const mensagemPersonalizada = `Setor: ${sector}${avisoOp}\nData/Hora: ${dataFormatada} - ${horaFormatada}\nMateriais:${listaMateriais}`;

    sendPushNotificationToRole('almoxarife', `Novo Pedido de ${nomeSolicitante}`, mensagemPersonalizada, '/requests');

    res.status(201).json({ success: true, id: requestId });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    
    if (error.message === "OP_OBRIGATORIA_TAGS") return res.status(400).json({ error: "É obrigatório informar o número da OP para estes tipos de produtos." });
    if (error.message === "OP_NAO_ENCONTRADA") return res.status(404).json({ error: "OP não encontrada no sistema. Verifique o número digitado." });
    if (error.message === "OP_FINALIZADA") return res.status(400).json({ error: "Essa OP ja foi finalizada, verifique a OP correta" });
    
    res.status(error.message.includes('Estoque disponível insuficiente') ? 400 : 500).json({ error: `Erro Técnico: ${error.message}` }); 
  } finally { 
    client.release(); 
  }
};

export const updateRequestStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const { status, rejection_reason, adjusted_items } = req.body;
  const client = await pool.connect();
  
  try {
    const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
    if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') return res.status(403).json({ error: 'Sem permissão.' });

    await client.query('BEGIN');
    const currentRes = await client.query('SELECT status, sector, client_service_id FROM requests WHERE id = $1 FOR UPDATE', [id]);
    if (!currentRes.rows[0]?.status) throw new Error("Solicitação não encontrada");
    
    const currentStatus = currentRes.rows[0].status;
    const reqSector = currentRes.rows[0].sector;
    const clientServiceId = currentRes.rows[0].client_service_id;

    // Se houve ajuste manual das quantidades pelo almoxarife antes da entrega
    if (adjusted_items && Array.isArray(adjusted_items)) {
       for (const adj of adjusted_items) {
          const itemCheck = await client.query('SELECT product_id, quantity_requested, quantity_delivered FROM request_items WHERE id = $1', [adj.id]);
          
          if (itemCheck.rows.length > 0) {
             const item = itemCheck.rows[0];
             const oldReserved = parseFloat(item.quantity_delivered ?? item.quantity_requested);
             const newReserved = parseFloat(adj.quantity_delivered);
             
             await client.query('UPDATE request_items SET quantity_delivered = $1 WHERE id = $2', [newReserved, adj.id]);
             
             if (item.product_id && oldReserved !== newReserved && (currentStatus === 'aberto' || currentStatus === 'aprovado')) {
                const stockVal = await client.query('SELECT quantity_reserved FROM stock WHERE product_id = $1', [item.product_id]);
                if (parseFloat(stockVal.rows[0]?.quantity_reserved || 0) > 0) {
                    const delta = newReserved - oldReserved;
                    await client.query('UPDATE stock SET quantity_reserved = GREATEST(0, COALESCE(quantity_reserved, 0) + $1) WHERE product_id = $2', [delta, item.product_id]);
                }
             }
          }
       }
    }

    const itemsRes = await client.query('SELECT ri.product_id, ri.quantity_requested, ri.quantity_delivered, p.is_3d FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id WHERE ri.request_id = $1 ORDER BY ri.product_id', [id]);

    // ==========================================
    // 🚀 RESOLUÇÃO DOS ARMAZÉNS E OP (MULTI-FILIAL)
    // ==========================================
    let armazemDestinoId = null;
    let armazemOrigemId = null;
    let reqOpId = null;

    if (status === 'entregue' || status === 'devolvido') {
        // 1. Localiza o ID da OP caso exista
        if (clientServiceId) {
            const csRes = await client.query('SELECT op_code FROM client_services WHERE id = $1', [clientServiceId]);
            if (csRes.rows.length > 0) {
                const opRes = await client.query('SELECT id FROM ordens_producao WHERE numero_op = $1', [csRes.rows[0].op_code]);
                if (opRes.rows.length > 0) reqOpId = opRes.rows[0].id;
            }
        }

        // 2. Garante o Armazém do Setor Solicitante
        if (reqSector) {
            let armazemRes = await client.query('SELECT id FROM armazens WHERE nome ILIKE $1', [reqSector]);
            if (armazemRes.rows.length === 0) {
                armazemRes = await client.query("INSERT INTO armazens (nome, tipo) VALUES ($1, 'setor') RETURNING id", [reqSector]);
            }
            armazemDestinoId = armazemRes.rows[0].id;
        }

        // 3. Garante o Armazém Principal (Origem)
        let armazemOrigemRes = await client.query("SELECT id FROM armazens WHERE tipo = 'principal' LIMIT 1");
        if (armazemOrigemRes.rows.length > 0) {
            armazemOrigemId = armazemOrigemRes.rows[0].id;
        } else {
            armazemOrigemRes = await client.query("INSERT INTO armazens (nome, tipo) VALUES ('Almoxarifado Principal', 'principal') RETURNING id");
            armazemOrigemId = armazemOrigemRes.rows[0].id;
        }
    }
    
    // =======================================================
    // APLICAÇÃO DOS STATUS E TRANSFERÊNCIAS 
    // =======================================================

    // Status: Entregue (Sai do Almoxarifado, Entra no Armazém do Setor)
    if (status === 'entregue' && (currentStatus === 'aberto' || currentStatus === 'aprovado')) {
      for (const item of itemsRes.rows) {
        if (item.product_id && !item.is_3d) { 
          const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
          
          // Baixa no Estoque Físico Geral (Mantido para integridade)
          const stockCheck = await client.query('SELECT quantity_on_hand FROM stock WHERE product_id = $1 FOR UPDATE', [item.product_id]);
          if (parseFloat(stockCheck.rows[0]?.quantity_on_hand || 0) < finalQty) throw new Error(`Furo de Estoque no produto ID ${item.product_id}.`);
          await client.query(`UPDATE stock SET quantity_on_hand = quantity_on_hand - $1, quantity_reserved = GREATEST(0, quantity_reserved - $1) WHERE product_id = $2`, [finalQty, item.product_id]);

          // Entrada Automática na gaveta do Setor
          if (armazemDestinoId) {
             const destCheck = await client.query(
                'SELECT id FROM estoque_armazem WHERE product_id = $1 AND armazem_id = $2 AND op_id IS NOT DISTINCT FROM $3', 
                [item.product_id, armazemDestinoId, reqOpId || null]
             );
             
             if (destCheck.rows.length > 0) {
                 await client.query('UPDATE estoque_armazem SET quantidade = quantidade + $1 WHERE id = $2', [finalQty, destCheck.rows[0].id]);
             } else {
                 try {
                     await client.query('INSERT INTO estoque_armazem (product_id, armazem_id, op_id, quantidade) VALUES ($1, $2, $3, $4)', [item.product_id, armazemDestinoId, reqOpId || null, finalQty]);
                 } catch(e) {
                     // Fallback se FK falhar
                     await client.query('INSERT INTO estoque_armazem (product_id, armazem_id, quantidade) VALUES ($1, $2, $3)', [item.product_id, armazemDestinoId, finalQty]);
                 }
             }

             // Gera o histórico inviolável de transferência
             try {
                 await client.query(`
                    INSERT INTO movimentacao_estoque (product_id, armazem_origem_id, armazem_destino_id, op_destino_id, quantidade, tipo_movimento, observacao, user_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 `, [item.product_id, armazemOrigemId, armazemDestinoId, reqOpId || null, finalQty, 'ENTREGA_SOLICITACAO', `Entregue via Req #${id.substring(0,8)}`, userId]);
             } catch(e) {
                  await client.query(`
                    INSERT INTO movimentacao_estoque (product_id, armazem_origem_id, armazem_destino_id, quantidade, tipo_movimento, observacao, user_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                 `, [item.product_id, armazemOrigemId, armazemDestinoId, finalQty, 'ENTREGA_SOLICITACAO', `Entregue via Req #${id.substring(0,8)}`, userId]);
             }
          }
        }
      }
    } 
    // Status: Rejeitado
    else if (status === 'rejeitado' && (currentStatus === 'aberto' || currentStatus === 'aprovado')) {
      for (const item of itemsRes.rows) {
        if (item.product_id && !item.is_3d) { 
            const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
            await client.query(`UPDATE stock SET quantity_reserved = GREATEST(0, COALESCE(quantity_reserved, 0) - $1) WHERE product_id = $2`, [finalQty, item.product_id]);
        }
      }
    }
    // Status: Devolvido Total (Retornou para a prateleira)
    else if (status === 'devolvido' && currentStatus === 'entregue') {
      for (const item of itemsRes.rows) {
        if (item.product_id && !item.is_3d) { 
            const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
            
            // Devolve ao estoque geral
            await client.query(`UPDATE stock SET quantity_on_hand = quantity_on_hand + $1 WHERE product_id = $2`, [finalQty, item.product_id]);
            
            // 🚀 Subtrai da gaveta do setor (Desfaz a transferência)
            if (armazemDestinoId) {
                const destCheck = await client.query('SELECT id FROM estoque_armazem WHERE product_id = $1 AND armazem_id = $2 AND op_id IS NOT DISTINCT FROM $3', [item.product_id, armazemDestinoId, reqOpId || null]);
                if (destCheck.rows.length > 0) {
                    await client.query('UPDATE estoque_armazem SET quantidade = GREATEST(0, quantidade - $1) WHERE id = $2', [finalQty, destCheck.rows[0].id]);
                }
                
                try {
                    await client.query(`
                        INSERT INTO movimentacao_estoque (product_id, armazem_origem_id, armazem_destino_id, op_origem_id, quantidade, tipo_movimento, observacao, user_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    `, [item.product_id, armazemDestinoId, armazemOrigemId, reqOpId || null, finalQty, 'DEVOLUCAO_SOLICITACAO', `Devolução Total Req #${id.substring(0,8)}`, userId]);
                } catch(e) {}
            }
        }
      }
    }

    await client.query('UPDATE requests SET status = $1, rejection_reason = $2 WHERE id = $3', [status, rejection_reason || null, id]);
    
    const logAction = status === 'entregue' ? 'ENTREGAR_SOLICITACAO' : status === 'rejeitado' ? 'REJEITAR_SOLICITACAO' : status === 'devolvido' ? 'DEVOLVER_SOLICITACAO' : 'ATUALIZAR_STATUS_SOLICITACAO';
    await createLog(userId, logAction, { id_solicitacao: id, novo_status: status, motivo: rejection_reason || 'N/A' }, getClientIp(req), client);
    
    await client.query('COMMIT');

    if ((req as any).io) { 
        (req as any).io.emit('request_updated', { id, status, rejection_reason }); 
        
        const changedProducts = itemsRes.rows.map(item => item.product_id).filter(id => id);
        if (changedProducts.length > 0) {
            (req as any).io.emit('stock_updated', { changedProducts });
        }
    }
    
    res.json({ success: true });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: error.message || 'Erro ao atualizar status' });
  } finally { client.release(); }
};

export const deleteRequest = async (req: Request, res: Response) => {
  const { id } = req.params;
  const userId = (req as any).user.id;
  const client = await pool.connect();
  try {
    const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
    if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') return res.status(403).json({ error: 'Sem permissão.' });

    await client.query('BEGIN');
    const reqRes = await client.query('SELECT status FROM requests WHERE id = $1 FOR UPDATE', [id]);
    if (reqRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Não encontrada.' }); }
    const { status } = reqRes.rows[0];

    if (status === 'rejeitado' || status === 'entregue' || status === 'devolvido') throw new Error('Não é possível cancelar no estado atual.');
    
    let itemsRes: any;
    if (status === 'aberto' || status === 'aprovado') {
       itemsRes = await client.query('SELECT ri.product_id, ri.quantity_requested, ri.quantity_delivered, p.is_3d FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id WHERE ri.request_id = $1', [id]);
       for (const item of itemsRes.rows) {
         if (item.product_id && !item.is_3d) {
            const finalQty = parseFloat(item.quantity_delivered ?? item.quantity_requested);
            await client.query(`UPDATE stock SET quantity_reserved = GREATEST(0, COALESCE(quantity_reserved, 0) - $1) WHERE product_id = $2`, [finalQty, item.product_id]);
         }
       }
    }

    await client.query("UPDATE requests SET status = 'rejeitado', rejection_reason = 'Cancelado pelo usuário/sistema' WHERE id = $1", [id]);
    
    await client.query("UPDATE demands_3d SET status = 'Cancelada' WHERE request_id = $1 AND status != 'Concluída'", [id]);

    await createLog(userId, 'CANCELAR_SOLICITACAO', { id_solicitacao: id, status_anterior: status }, getClientIp(req), client);
    await client.query('COMMIT');
    
    if ((req as any).io) { 
        (req as any).io.emit('request_updated', { id, status: 'rejeitado', rejection_reason: 'Cancelado pelo usuário/sistema' }); 
        
        if (itemsRes && itemsRes.rows) {
            const changedProducts = itemsRes.rows.map((item: any) => item.product_id).filter((id: any) => id);
            if (changedProducts.length > 0) {
                (req as any).io.emit('stock_updated', { changedProducts });
            }
        }
    }
    
    res.json({ success: true, message: 'Pedido cancelado.' });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: error.message });
  } finally { client.release(); }
};

// =========================================================================
// 🟢 NOVA ROTA: DEVOLUÇÃO PARCIAL DE SOLICITAÇÕES COM INTEGRAÇÃO À OP
// =========================================================================

export const partialReturnRequest = async (req: Request, res: Response) => {
  const { id } = req.params; 
  const userId = (req as any).user.id;
  const { returns } = req.body; 
  const client = await pool.connect();
  
  try {
    const userCheck = await pool.query('SELECT role FROM profiles WHERE id = $1', [userId]);
    if (userCheck.rows[0]?.role !== 'admin' && userCheck.rows[0]?.role !== 'almoxarife') return res.status(403).json({ error: 'Sem permissão.' });

    await client.query('BEGIN');

    const reqRes = await client.query('SELECT status, client_service_id, sector FROM requests WHERE id = $1', [id]);
    if (!reqRes.rows[0] || reqRes.rows[0].status !== 'entregue') {
        throw new Error("Apenas solicitações 'entregues' podem ter itens devolvidos.");
    }
    
    const client_service_id = reqRes.rows[0].client_service_id;
    const reqSector = reqRes.rows[0].sector;

    // Localiza OP e Armazéns para desfazer no multi-filial
    let armazemDestinoId = null;
    let reqOpId = null;
    let armazemOrigemId = null;

    if (client_service_id) {
        const csRes = await client.query('SELECT op_code FROM client_services WHERE id = $1', [client_service_id]);
        if (csRes.rows.length > 0) {
            const opRes = await client.query('SELECT id FROM ordens_producao WHERE numero_op = $1', [csRes.rows[0].op_code]);
            if (opRes.rows.length > 0) reqOpId = opRes.rows[0].id;
        }
    }
    if (reqSector) {
        let armazemRes = await client.query('SELECT id FROM armazens WHERE nome ILIKE $1', [reqSector]);
        if (armazemRes.rows.length > 0) armazemDestinoId = armazemRes.rows[0].id;
    }
    let armazemOrigemRes = await client.query("SELECT id FROM armazens WHERE tipo = 'principal' LIMIT 1");
    if (armazemOrigemRes.rows.length > 0) armazemOrigemId = armazemOrigemRes.rows[0].id;

    for (const ret of returns) {
      if (ret.quantity_to_return <= 0) continue;

      const itemCheck = await client.query(
          'SELECT product_id, quantity_delivered, quantity_requested, quantity_returned, is_3d FROM request_items ri LEFT JOIN products p ON ri.product_id = p.id WHERE ri.id = $1', 
          [ret.request_item_id]
      );
      
      const item = itemCheck.rows[0];
      const delivered = parseFloat(item.quantity_delivered ?? item.quantity_requested);
      const alreadyReturned = parseFloat(item.quantity_returned ?? 0);
      const returnQty = parseFloat(ret.quantity_to_return);

      if (alreadyReturned + returnQty > delivered) {
          throw new Error(`Não podes devolver mais do que foi entregue para o produto.`);
      }

      await client.query('UPDATE request_items SET quantity_returned = COALESCE(quantity_returned, 0) + $1 WHERE id = $2', [returnQty, ret.request_item_id]);

      if (item.product_id && !item.is_3d) {
          // Devolve ao estoque geral
          await client.query('UPDATE stock SET quantity_on_hand = quantity_on_hand + $1 WHERE product_id = $2', [returnQty, item.product_id]);
          
          // 🚀 Retira da gaveta do setor
          if (armazemDestinoId) {
             const destCheck = await client.query('SELECT id FROM estoque_armazem WHERE product_id = $1 AND armazem_id = $2 AND op_id IS NOT DISTINCT FROM $3', [item.product_id, armazemDestinoId, reqOpId || null]);
             if (destCheck.rows.length > 0) {
                 await client.query('UPDATE estoque_armazem SET quantidade = GREATEST(0, quantidade - $1) WHERE id = $2', [returnQty, destCheck.rows[0].id]);
             }
             try {
                 await client.query(`
                    INSERT INTO movimentacao_estoque (product_id, armazem_origem_id, armazem_destino_id, op_origem_id, quantidade, tipo_movimento, observacao, user_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 `, [item.product_id, armazemDestinoId, armazemOrigemId, reqOpId || null, returnQty, 'DEVOLUCAO_SOLICITACAO', `Devolução parcial Req #${id.substring(0,8)}`, userId]);
             } catch(e) {}
          }
      }

      if (client_service_id && item.product_id) {
          await client.query(`
              INSERT INTO op_returns (client_service_id, product_id, quantity, user_id, observation)
              VALUES ($1, $2, $3, $4, $5)
          `, [client_service_id, item.product_id, returnQty, userId, "Devolução parcial via Solicitação"]);
      }
    }

    await createLog(userId, 'DEVOLUCAO_PARCIAL', { id_solicitacao: id }, getClientIp(req), client);
    
    await client.query('COMMIT');

    if ((req as any).io) { 
        (req as any).io.emit('refresh_requests');
        (req as any).io.emit('refresh_stock');
    }

    res.json({ success: true, message: "Devolução parcial processada com sucesso!" });
  } catch (error: any) {
    try { await client.query('ROLLBACK'); } catch(e) {}
    res.status(500).json({ error: error.message || 'Erro ao processar devolução parcial' });
  } finally { client.release(); }
};
