import assert from "node:assert/strict";
import { extrairDados, acharTelefone, acharValor, acharNome, acharModelo, acharSeguradora, acharDataEntrega, paraNumero } from "../assets/parse.js";

const cotacao = `PORTO SEGURO — Cotação de Seguro Moto
Segurado: MARIA DA SILVA SOUZA   CPF: 123.456.789-09
Telefone: (68) 99912-3456
Veículo: HONDA CG 160 START   Placa: ABC1D23
Vigência: 12 meses
Prêmio total: R$ 1.234,56
Parcelado em 10x de R$ 130,00
Data de entrega: 25/11/2026`;
const r = extrairDados(cotacao);
assert.equal(r.nome, "Maria da Silva Souza");
assert.equal(r.telefone, "(68) 99912-3456");
assert.equal(r.valor_cotacao, 1234.56);
assert.equal(r.seguradora, "Porto Seguro");
assert.equal(r.data_entrega, "2026-11-25");
assert.match(r.modelo_moto, /CG 160/);

// nunca inventar: texto sem dados úteis
assert.equal(extrairDados("Lorem ipsum dolor sit amet, consectetur adipiscing elit"), null);
assert.equal(extrairDados("curto"), null);

// CPF/apólice não viram telefone
assert.equal(acharTelefone("CPF 123.456.789-09 Apólice 0531234567890"), null);
// vários telefones sem rótulo → não escolhe
assert.equal(acharTelefone("68 99912-3456\n68 98811-2233"), null);
// um telefone sem rótulo → aceita
assert.equal(acharTelefone("fale conosco 68 99912-3456"), "(68) 99912-3456");
// DDD inválido e dígito repetido
assert.equal(acharTelefone("Telefone: 00 99999-9999"), null);
assert.equal(acharTelefone("Telefone: (68) 99999-9999"), null);
// +55
assert.equal(acharTelefone("Cel: +55 (68) 98123-4567"), "(68) 98123-4567");
// valor: ignora parcelas e valores sem rótulo
assert.equal(acharValor("Parcela: R$ 99,90\nOutro R$ 5,00"), null);
assert.equal(acharValor("Valor: R$ 2.450,00"), 2450);
assert.equal(paraNumero("1.234,56"), 1234.56);
// nome: rótulo obrigatório
assert.equal(acharNome("Maria Souza\nCotação"), null);
assert.equal(acharNome("Nome: Seguro Total Moto"), null);
assert.equal(acharNome("Cliente: joão pedro de oliveira"), "João Pedro de Oliveira");
// modelo sem rótulo
assert.match(acharModelo("Proposta para PCX 160 zero km"), /PCX 160/);
assert.equal(acharModelo("Nada aqui sobre motos de verdade"), null);
// data absurda
assert.equal(acharDataEntrega("Entrega: 31/02/2026"), null);
assert.equal(acharDataEntrega("Entrega: 01/01/2000"), null);
assert.equal(acharSeguradora("cotacao tokio marine moto"), "Tokio Marine");
assert.equal(acharSeguradora("HDI"), "HDI");
assert.equal(acharSeguradora("chdi xyz"), null);
console.log("parse: todos os testes passaram");
