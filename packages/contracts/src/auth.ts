import { Type, type Static } from 'typebox';
import { MetaSchema, RequestIdSchema, UuidSchema, successSchema } from './common.js';
const closed = { additionalProperties: false };
export const PasswordSchema = Type.String({ minLength: 12, maxLength: 128, writeOnly: true, description: 'Senha preservada integralmente; sem trim ou normalização.' });
const Login = Type.String({ minLength: 1, maxLength: 120 });
const Name = Type.String({ minLength: 1, maxLength: 120 });
const InputName = Type.String({ minLength: 1, maxLength: 1024, description: 'Até 120 caracteres após NFC/trim; limite bruto protege a entrada.' });
const Token = Type.String({ minLength: 32, maxLength: 256 });
const Role = Type.Union([Type.Literal('admin'),Type.Literal('operator')]);
const Empty = Type.Object({}, closed);
export const UserSchema = Type.Object({ id: UuidSchema, login: Login, name: Name, role: Role, active: Type.Boolean(),
  permissions_version: Type.Integer({ minimum: 1 }), version: Type.Integer({ minimum: 1 }) }, closed);
export const ContextSchema = Type.Object({ store_id: UuidSchema, user_id: UuidSchema, device_id: Type.Union([UuidSchema,Type.Null()]),
  permissions: Type.Array(Type.String(), { maxItems: 30 }), permissions_version: Type.Integer({ minimum: 1 }), authorization_id: UuidSchema,
  authorization_origin: Type.Union([Type.Literal('online'),Type.Literal('offline')]), authorized_at: Type.String(), expires_at: Type.String() }, closed);
const Device = Type.Object({ id: UuidSchema, code: Type.String(), active: Type.Boolean(), version: Type.Integer() }, closed);
export const ActivateBody = Type.Object({ installation_token: Token, store_name: InputName, login: InputName, name: InputName, password: PasswordSchema }, closed);
export const LoginBody = Type.Object({ login: InputName, password: Type.String({ minLength: 1, maxLength: 128, writeOnly: true }) }, closed);
export const CreateUserBody = Type.Object({ operation_id: UuidSchema, login: InputName, name: InputName, password: PasswordSchema, role: Role }, closed);
export const UpdateUserBody = Type.Object({ operation_id: UuidSchema, expected_version: Type.Integer({ minimum: 1 }),
  name: Type.Optional(InputName), role: Type.Optional(Role), active: Type.Optional(Type.Boolean()), password: Type.Optional(PasswordSchema) }, closed);
export const EnrollBody = Type.Object({ invitation_token: Token, device_id: UuidSchema }, closed);
export const VersionBody = Type.Object({ operation_id: UuidSchema, expected_version: Type.Integer({ minimum: 1 }) }, closed);
export const IdParams = Type.Object({ id: UuidSchema }, closed);
export const EmptyBody = Empty;
export const AuthResponse = successSchema(Type.Object({ user: UserSchema, context: ContextSchema, csrf_token: Token }, closed));
export const MeResponse = successSchema(Type.Object({ user: UserSchema, context: ContextSchema }, closed));
export const UsersResponse = successSchema(Type.Object({ items: Type.Array(UserSchema, { maxItems: 100 }) }, closed));
export const DevicesResponse = successSchema(Type.Object({ items: Type.Array(Device, { maxItems: 100 }) }, closed));
export const InvitationResponse = successSchema(Type.Object({ invitation_token: Token, expires_at: Type.String() }, closed));
export const EnrollmentData = Type.Object({ device_id: UuidSchema, store_id: UuidSchema, code: Type.String(), device_credential: Token, grant_public_key: Type.String() }, closed);
export const EnrollmentResponse = successSchema(EnrollmentData);
export const DeviceChangeResponse = successSchema(Type.Object({ id: UuidSchema, active: Type.Boolean(), version: Type.Integer(), device_credential: Type.Optional(Token) }, closed));
export const OfflineGrantResponse = successSchema(Type.Object({ authorization: Type.String({ maxLength: 16384 }), expires_at: Type.String() }, closed));
export const OkResponse = successSchema(Type.Object({ ok: Type.Literal(true) }, closed));
export const authIpcCommands = Type.Union([
  Type.Object({ type: Type.Literal('auth.loginOnline'), request_id: RequestIdSchema, login: InputName, password: Type.String({ minLength: 1, maxLength: 128 }) }, closed),
  Type.Object({ type: Type.Literal('auth.loginOffline'), request_id: RequestIdSchema, login: InputName, password: Type.String({ minLength: 1, maxLength: 128 }) }, closed),
  Type.Object({ type: Type.Union([Type.Literal('auth.getContext'),Type.Literal('auth.logout'),Type.Literal('device.getStatus')]), request_id: RequestIdSchema }, closed),
  Type.Object({ type: Type.Literal('device.enroll'), request_id: RequestIdSchema, invitation_token: Token }, closed),
]);
export type AuthIpcCommand = Static<typeof authIpcCommands>;
export const AuthIpcResponse = Type.Object({ type: Type.Literal('auth.result'), data: Type.Union([
  Type.Object({ context: ContextSchema }, closed), Type.Object({ ok: Type.Literal(true) }, closed),
  Type.Object({ paired: Type.Boolean(), device_id: UuidSchema, store_id: UuidSchema, code: Type.Optional(Type.String()), offline_enabled: Type.Boolean() }, closed),
]), meta: MetaSchema }, closed);

const exampleId = '550e8400-e29b-41d4-a716-446655440000';
const exampleToken = 'example-only-not-a-real-token-0123456789';
const exampleUser = {id:exampleId,login:'operador.exemplo',name:'Operador de exemplo',role:'operator',active:true,permissions_version:1,version:1};
const exampleContext = {store_id:exampleId,user_id:exampleId,device_id:null,permissions:['catalog.read'],permissions_version:1,authorization_id:exampleId,authorization_origin:'online',authorized_at:'2026-11-24T12:00:00.000Z',expires_at:'2026-11-24T12:15:00.000Z'};
const envelope = (data: unknown) => ({data,meta:{request_id:'example-request'}});
for (const [schema, example] of [
  [ActivateBody,{installation_token:exampleToken,store_name:'Loja de exemplo',login:'dono.exemplo',name:'Dono de exemplo',password:'Example-only-password-123!'}],
  [LoginBody,{login:'operador.exemplo',password:'Example-only-password-123!'}],
  [CreateUserBody,{operation_id:exampleId,login:'operador.exemplo',name:'Operador de exemplo',password:'Example-only-password-123!',role:'operator'}],
  [UpdateUserBody,{operation_id:exampleId,expected_version:1,name:'Nome revisado'}],
  [EnrollBody,{invitation_token:exampleToken,device_id:exampleId}], [VersionBody,{operation_id:exampleId,expected_version:1}], [EmptyBody,{}],
  [UserSchema,exampleUser], [AuthResponse,envelope({user:exampleUser,context:exampleContext,csrf_token:exampleToken})], [MeResponse,envelope({user:exampleUser,context:exampleContext})],
  [UsersResponse,envelope({items:[exampleUser]})], [DevicesResponse,envelope({items:[{id:exampleId,code:'CX01',active:true,version:1}]})],
  [InvitationResponse,envelope({invitation_token:exampleToken,expires_at:'2026-11-24T12:10:00.000Z'})],
  [EnrollmentResponse,envelope({device_id:exampleId,store_id:exampleId,code:'CX01',device_credential:exampleToken,grant_public_key:'PEM_PUBLIC_KEY_FROM_SERVER'})],
  [DeviceChangeResponse,envelope({id:exampleId,active:false,version:2})], [OfflineGrantResponse,envelope({authorization:'SIGNED_OFFLINE_AUTHORIZATION_FROM_SERVER',expires_at:'2026-11-25T12:00:00.000Z'})],
  [OkResponse,envelope({ok:true})],
] as const) Object.assign(schema,{example});
